// controllers/FilesController.js
import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import Queue from 'bull';
import dbClient from '../utils/db';
import redisClient from '../utils/redis';

const fileQueue = new Queue('fileQueue');

const FOLDER_PATH = process.env.FOLDER_PATH && process.env.FOLDER_PATH.trim().length
  ? process.env.FOLDER_PATH
  : '/tmp/files_manager';

function ensureFolder(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function getUserFromToken(req) {
  const token = req.header('X-Token');
  console.log('Getting user from token:', token ? 'Token present' : 'No token');
  
  if (!token) return null;
  
  try {
    // Check if Redis is alive
    if (!redisClient.isAlive()) {
      console.error('Redis is not alive');
      return null;
    }
    
    const userId = await redisClient.get(`auth_${token}`);
    console.log('User ID from Redis:', userId);
    
    if (!userId) return null;
    
    // Check if DB is alive
    if (!dbClient.isAlive()) {
      console.error('MongoDB is not alive');
      return null;
    }
    
    const user = await dbClient.collection('users').findOne({ _id: new ObjectId(userId) });
    console.log('User found:', user ? 'Yes' : 'No');
    
    return user || null;
  } catch (error) {
    console.error('Error in getUserFromToken:', error);
    return null;
  }
}

function normalizeParentId(parentId) {
  if (!parentId || parentId === 0 || parentId === '0') return 0;
  try { return new ObjectId(parentId); } catch (e) { return null; }
}

function presentFile(doc) {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    name: doc.name,
    type: doc.type,
    isPublic: doc.isPublic,
    parentId: doc.parentId === 0 ? 0 : doc.parentId.toString(),
  };
}

class FilesController {
  static async postUpload(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const {
        name, type, parentId, isPublic = false, data,
      } = req.body || {};

      if (!name) return res.status(400).json({ error: 'Missing name' });
      if (!type || !['folder', 'file', 'image'].includes(type)) {
        return res.status(400).json({ error: 'Missing type' });
      }
      if (type !== 'folder' && (data === undefined || data === null)) {
        return res.status(400).json({ error: 'Missing data' });
      }

      let parent = null;
      const parentNorm = normalizeParentId(parentId);
      if (parentNorm === null) return res.status(400).json({ error: 'Parent not found' });
      if (parentNorm !== 0) {
        parent = await dbClient.collection('files').findOne({ _id: parentNorm });
        if (!parent) return res.status(400).json({ error: 'Parent not found' });
        if (parent.type !== 'folder') return res.status(400).json({ error: 'Parent is not a folder' });
      }

      const doc = {
        userId: user._id,
        name,
        type,
        isPublic: Boolean(isPublic),
        parentId: parentNorm || 0,
      };

      ensureFolder(FOLDER_PATH);

      if (type === 'folder') {
        const { insertedId } = await dbClient.collection('files').insertOne(doc);
        const saved = await dbClient.collection('files').findOne({ _id: insertedId });
        return res.status(201).json(presentFile(saved));
      }

      // file | image
      const fileUUID = uuidv4();
      const localPath = path.join(FOLDER_PATH, fileUUID);
      try {
        const buffer = Buffer.from(data, 'base64');
        fs.writeFileSync(localPath, buffer);
      } catch (e) {
        return res.status(500).json({ error: 'Cannot store file' });
      }
      doc.localPath = localPath;

      const { insertedId } = await dbClient.collection('files').insertOne(doc);
      const saved = await dbClient.collection('files').findOne({ _id: insertedId });

      // Enqueue thumbnails generation for images
      if (type === 'image') {
        await fileQueue.add({ userId: user._id.toString(), fileId: insertedId.toString() });
      }

      return res.status(201).json(presentFile(saved));
    } catch (error) {
      console.error('Error in postUpload:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async getShow(req, res) {
    console.log('getShow called with ID:', req.params.id);
    
    try {
      const user = await getUserFromToken(req);
      if (!user) {
        console.log('No user found, returning 401');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      console.log('User found, looking for file...');
      const file = await dbClient.collection('files').findOne({
        _id: new ObjectId(req.params.id),
        userId: user._id,
      });

      if (!file) {
        console.log('File not found, returning 404');
        return res.status(404).json({ error: 'Not found' });
      }

      console.log('File found, returning file data');
      return res.status(200).json(presentFile(file));
    } catch (error) {
      console.error('Error in getShow:', error);
      return res.status(404).json({ error: 'Not found' });
    }
  }

  static async getIndex(req, res) {
    console.log('getIndex called');
    console.log('Query params:', req.query);
    
    try {
      // Check DB connection first
      if (!dbClient.isAlive()) {
        console.error('Database is not connected');
        return res.status(500).json({ error: 'Database connection error' });
      }

      console.log('Getting user from token...');
      const user = await getUserFromToken(req);
      if (!user) {
        console.log('No user found, returning 401');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      console.log('User found:', user._id.toString());

      const page = Number.isNaN(parseInt(req.query.page, 10)) ? 0 : parseInt(req.query.page, 10);
      const parentId = req.query.parentId;
      
      console.log('Page:', page, 'ParentId:', parentId);

      // Handle parentId
      let parentNorm;
      if (parentId === undefined || parentId === null || parentId === '') {
        parentNorm = 0;
        console.log('No parentId provided, using root (0)');
      } else {
        parentNorm = normalizeParentId(parentId);
        console.log('Normalized parentId:', parentNorm);
      }

      // Build match criteria
      const match = {
        userId: user._id,
        parentId: parentNorm
      };

      console.log('Match criteria:', JSON.stringify(match));

      // Simple query first to test connection
      try {
        console.log('Testing simple count query...');
        const count = await dbClient.collection('files').countDocuments(match);
        console.log('Found', count, 'files matching criteria');
      } catch (countError) {
        console.error('Count query failed:', countError);
        return res.status(500).json({ error: 'Database query error' });
      }

      // Build aggregation pipeline
      const pipeline = [
        { $match: match },
        { $sort: { _id: 1 } },
        { $skip: page * 20 },
        { $limit: 20 },
      ];

      console.log('Running aggregation pipeline...');
      const docs = await dbClient.collection('files').aggregate(pipeline).toArray();
      
      console.log('Found', docs.length, 'files');
      const result = docs.map(presentFile);
      
      return res.status(200).json(result);
    } catch (error) {
      console.error('Error in getIndex:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async putPublish(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const _id = new ObjectId(req.params.id);
      const file = await dbClient.collection('files').findOne({ _id, userId: user._id });
      if (!file) return res.status(404).json({ error: 'Not found' });

      await dbClient.collection('files').updateOne({ _id }, { $set: { isPublic: true } });
      const updated = await dbClient.collection('files').findOne({ _id });
      return res.status(200).json(presentFile(updated));
    } catch (error) {
      console.error('Error in putPublish:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async putUnpublish(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const _id = new ObjectId(req.params.id);
      const file = await dbClient.collection('files').findOne({ _id, userId: user._id });
      if (!file) return res.status(404).json({ error: 'Not found' });

      await dbClient.collection('files').updateOne({ _id }, { $set: { isPublic: false } });
      const updated = await dbClient.collection('files').findOne({ _id });
      return res.status(200).json(presentFile(updated));
    } catch (error) {
      console.error('Error in putUnpublish:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async getFile(req, res) {
    try {
      const { id } = req.params;
      const size = req.query.size;

      let file;
      try {
        file = await dbClient.collection('files').findOne({ _id: new ObjectId(id) });
      } catch (e) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (!file) return res.status(404).json({ error: 'Not found' });

      // Access control
      if (!file.isPublic) {
        const user = await getUserFromToken(req);
        if (!user || user._id.toString() !== file.userId.toString()) {
          return res.status(404).json({ error: 'Not found' });
        }
      }

      if (file.type === 'folder') return res.status(400).json({ error: "A folder doesn't have content" });

      let localPath = file.localPath;
      if (size && ['500', '250', '100'].includes(String(size))) {
        localPath = `${file.localPath}_${size}`;
      }

      if (!fs.existsSync(localPath)) return res.status(404).json({ error: 'Not found' });

      const mimeType = mime.lookup(file.name) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      const data = fs.readFileSync(localPath);
      return res.status(200).send(data);
    } catch (error) {
      console.error('Error in getFile:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export default FilesController;
