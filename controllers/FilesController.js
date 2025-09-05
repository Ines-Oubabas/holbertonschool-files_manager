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
  if (!token) return null;
  
  try {
    const userId = await Promise.race([
      redisClient.get(`auth_${token}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 5000))
    ]);
    
    if (!userId) return null;
    
    const user = await Promise.race([
      dbClient.collection('users').findOne({ _id: new ObjectId(userId) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB timeout')), 5000))
    ]);
    
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
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const file = await dbClient.collection('files').findOne({
        _id: new ObjectId(req.params.id),
        userId: user._id,
      });
      if (!file) return res.status(404).json({ error: 'Not found' });

      return res.status(200).json(presentFile(file));
    } catch (error) {
      console.error('Error in getShow:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async getIndex(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const page = Number.isNaN(parseInt(req.query.page, 10)) ? 0 : parseInt(req.query.page, 10);
      const parentId = req.query.parentId;
      
      // Handle parentId properly - when undefined, default to 0 (root level)
      let parentNorm;
      if (parentId === undefined || parentId === null || parentId === '') {
        parentNorm = 0;
      } else {
        parentNorm = normalizeParentId(parentId);
        // If parentId was provided but is invalid ObjectId -> return empty array
        if (parentNorm === null) {
          return res.status(200).json([]);
        }
      }

      const match = { 
        userId: user._id, 
        parentId: parentNorm 
      };

      const pipeline = [
        { $match: match },
        { $sort: { _id: 1 } },
        { $skip: page * 20 },
        { $limit: 20 },
      ];

      // Add timeout to the aggregation query
      const docs = await Promise.race([
        dbClient.collection('files').aggregate(pipeline).toArray(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 10000))
      ]);

      return res.status(200).json(docs.map(presentFile));
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
