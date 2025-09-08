// controllers/FilesController.js
import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import Queue from 'bull';
import dbClient from '../utils/db.mjs';
import redisClient from '../utils/redis.mjs';

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
    if (!redisClient.isAlive()) return null;
    const userId = await redisClient.get(`auth_${token}`);
    if (!userId) return null;
    if (!dbClient.isAlive()) return null;

    const usersCollection = await dbClient.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
    return user || null;
  } catch (error) {
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
    userId: doc.userId,
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

      const filesCollection = await dbClient.collection('files');

      let parent = null;
      const parentNorm = normalizeParentId(parentId);
      if (parentNorm === null) return res.status(400).json({ error: 'Parent not found' });
      if (parentNorm !== 0) {
        parent = await filesCollection.findOne({ _id: parentNorm });
        if (!parent) return res.status(400).json({ error: 'Parent not found' });
        if (parent.type !== 'folder') return res.status(400).json({ error: 'Parent is not a folder' });
      }

      const doc = {
        userId: user._id.toString(),
        name,
        type,
        isPublic: Boolean(isPublic),
        parentId: parentNorm || 0,
      };

      ensureFolder(FOLDER_PATH);

      if (type === 'folder') {
        const { insertedId } = await filesCollection.insertOne(doc);
        const saved = await filesCollection.findOne({ _id: insertedId });
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

      const { insertedId } = await filesCollection.insertOne(doc);
      const saved = await filesCollection.findOne({ _id: insertedId });

      if (type === 'image') {
        await fileQueue.add({ userId: user._id.toString(), fileId: insertedId.toString() });
      }

      return res.status(201).json(presentFile(saved));
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async getShow(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const filesCollection = await dbClient.collection('files');
      const file = await filesCollection.findOne({
        _id: new ObjectId(req.params.id),
        userId: user._id.toString(),
      });

      if (!file) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(presentFile(file));
    } catch (error) {
      return res.status(404).json({ error: 'Not found' });
    }
  }

  static async getIndex(req, res) {
    try {
      if (!dbClient.isAlive()) return res.status(500).json({ error: 'Database connection error' });

      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const page = Number.isNaN(parseInt(req.query.page, 10)) ? 0 : parseInt(req.query.page, 10);
      const parentId = req.query.parentId;

      let parentNorm;
      if (parentId === undefined || parentId === null || parentId === '') {
        parentNorm = 0;
      } else {
        parentNorm = normalizeParentId(parentId);
      }

      const match = {
        userId: user._id.toString(),
        parentId: parentNorm,
      };

      const filesCollection = await dbClient.collection('files');
      const pipeline = [
        { $match: match },
        { $sort: { _id: 1 } },
        { $skip: page * 20 },
        { $limit: 20 },
      ];

      const docs = await filesCollection.aggregate(pipeline).toArray();
      const result = docs.map(presentFile);

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async putPublish(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const filesCollection = await dbClient.collection('files');
      const _id = new ObjectId(req.params.id);
      const file = await filesCollection.findOne({ _id, userId: user._id.toString() });
      if (!file) return res.status(404).json({ error: 'Not found' });

      await filesCollection.updateOne({ _id }, { $set: { isPublic: true } });
      const updated = await filesCollection.findOne({ _id });
      return res.status(200).json(presentFile(updated));
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async putUnpublish(req, res) {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const filesCollection = await dbClient.collection('files');
      const _id = new ObjectId(req.params.id);
      const file = await filesCollection.findOne({ _id, userId: user._id.toString() });
      if (!file) return res.status(404).json({ error: 'Not found' });

      await filesCollection.updateOne({ _id }, { $set: { isPublic: false } });
      const updated = await filesCollection.findOne({ _id });
      return res.status(200).json(presentFile(updated));
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async getFile(req, res) {
    try {
      const { id } = req.params;
      const size = req.query.size;

      const filesCollection = await dbClient.collection('files');
      let file;
      try {
        file = await filesCollection.findOne({ _id: new ObjectId(id) });
      } catch (e) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (!file) return res.status(404).json({ error: 'Not found' });

      if (!file.isPublic) {
        const user = await getUserFromToken(req);
        if (!user || user._id.toString() !== file.userId) {
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
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export default FilesController;
