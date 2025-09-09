// controllers/FilesController.js
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ObjectId } from 'mongodb';
import mime from 'mime-types';
import Queue from 'bull';
import dbClient from '../utils/db.mjs';
import redisClient from '../utils/redis.mjs';

const VALID_TYPES = new Set(['folder', 'file', 'image']);
const DEFAULT_STORAGE = '/tmp/files_manager';

// Bull queue pour les thumbnails (Bull v3, Redis local)
const fileQueue = new Queue('fileQueue');

/** Helpers (compatibles Babel 6 — pas de champs privés) */
async function authUserId(req) {
  const token = req.header('X-Token');
  if (!token) return null;
  try {
    const userIdStr = await redisClient.get(`auth_${token}`);
    return userIdStr || null;
  } catch {
    return null;
  }
}

function normalizeParentIdForResponse(parentId) {
  return parentId === 0 ? 0 : (parentId ? parentId.toString() : 0);
}

export default class FilesController {
  /** Task 5: POST /files (upload/create) + Task 9: enqueue thumbnails for images */
  static async postUpload(req, res) {
    try {
      const userIdStr = await authUserId(req);
      if (!userIdStr) return res.status(401).json({ error: 'Unauthorized' });

      const usersCol = dbClient.db.collection('users');
      const user = await usersCol.findOne({ _id: new ObjectId(userIdStr) });
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { name, type, parentId = 0, isPublic = false, data } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing name' });
      if (!type || !VALID_TYPES.has(type)) return res.status(400).json({ error: 'Missing type' });
      if (type !== 'folder' && !data) return res.status(400).json({ error: 'Missing data' });

      const filesCol = dbClient.db.collection('files');

      // Parent checks
      let parentDoc = null;
      let parentIdToStore = 0;
      if (parentId && parentId !== 0 && parentId !== '0') {
        let parentObjId;
        try { parentObjId = new ObjectId(parentId); } catch { return res.status(400).json({ error: 'Parent not found' }); }
        parentDoc = await filesCol.findOne({ _id: parentObjId });
        if (!parentDoc) return res.status(400).json({ error: 'Parent not found' });
        if (parentDoc.type !== 'folder') return res.status(400).json({ error: 'Parent is not a folder' });
        parentIdToStore = parentObjId;
      }

      const baseDoc = {
        userId: new ObjectId(user._id),
        name,
        type,
        isPublic: !!isPublic,
        parentId: parentIdToStore || 0,
      };

      // Folder: insert direct
      if (type === 'folder') {
        const result = await filesCol.insertOne(baseDoc);
        return res.status(201).json({
          id: result.insertedId.toString(),
          userId: user._id.toString(),
          name,
          type,
          isPublic: !!isPublic,
          parentId: normalizeParentIdForResponse(parentIdToStore || 0),
        });
      }

      // file/image: write to disk
      const rootFolder = (process.env.FOLDER_PATH && process.env.FOLDER_PATH.trim())
        ? process.env.FOLDER_PATH.trim()
        : DEFAULT_STORAGE;
      await fs.mkdir(rootFolder, { recursive: true });

      const filename = uuidv4();
      const localPath = path.join(rootFolder, filename);

      let fileContent;
      try { fileContent = Buffer.from(data, 'base64'); } catch { return res.status(400).json({ error: 'Missing data' }); }
      await fs.writeFile(localPath, fileContent, { flag: 'w' });

      const fileDoc = { ...baseDoc, localPath };
      const result = await filesCol.insertOne(fileDoc);

      // Task 9: si image => ajouter un job Bull (userId + fileId)
      if (type === 'image') {
        try {
          await fileQueue.add({
            userId: user._id.toString(),
            fileId: result.insertedId.toString(),
          });
        } catch {
          // On n'échoue pas l'upload si la queue n'est pas joignable
        }
      }

      return res.status(201).json({
        id: result.insertedId.toString(),
        userId: user._id.toString(),
        name,
        type,
        isPublic: !!isPublic,
        parentId: normalizeParentIdForResponse(parentIdToStore || 0),
      });
    } catch {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  /** Task 6: GET /files/:id */
  static async getShow(req, res) {
    try {
      const userIdStr = await authUserId(req);
      if (!userIdStr) return res.status(401).json({ error: 'Unauthorized' });

      let fileId;
      try { fileId = new ObjectId(req.params.id); } catch { return res.status(404).json({ error: 'Not found' }); }

      const filesCol = dbClient.db.collection('files');
      const file = await filesCol.findOne({ _id: fileId, userId: new ObjectId(userIdStr) });
      if (!file) return res.status(404).json({ error: 'Not found' });

      return res.status(200).json({
        id: file._id.toString(),
        userId: file.userId.toString(),
        name: file.name,
        type: file.type,
        isPublic: !!file.isPublic,
        parentId: normalizeParentIdForResponse(file.parentId),
      });
    } catch {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  /** Task 6: GET /files (list + pagination) */
  static async getIndex(req, res) {
    try {
      const userIdStr = await authUserId(req);
      if (!userIdStr) return res.status(401).json({ error: 'Unauthorized' });

      const pageQ = parseInt(req.query.page, 10);
      const pageNum = Number.isFinite(pageQ) && pageQ >= 0 ? pageQ : 0;
      const limit = 20;
      const skip = pageNum * limit;

      let parentMatch = 0;
      if (typeof req.query.parentId !== 'undefined' && req.query.parentId !== '0' && req.query.parentId !== 0) {
        try { parentMatch = new ObjectId(req.query.parentId); }
        catch { return res.status(200).json([]); }
      }

      const filesCol = dbClient.db.collection('files');
      const docs = await filesCol.aggregate([
        { $match: { userId: new ObjectId(userIdStr), parentId: parentMatch } },
        { $sort: { _id: 1 } },
        { $skip: skip },
        { $limit: limit },
      ]).toArray();

      const out = docs.map((f) => ({
        id: f._id.toString(),
        userId: f.userId.toString(),
        name: f.name,
        type: f.type,
        isPublic: !!f.isPublic,
        parentId: normalizeParentIdForResponse(f.parentId),
      }));

      return res.status(200).json(out);
    } catch {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  /** Task 7: PUT /files/:id/publish */
  static async putPublish(req, res) {
    return FilesController._togglePublic(req, res, true);
  }

  /** Task 7: PUT /files/:id/unpublish */
  static async putUnpublish(req, res) {
    return FilesController._togglePublic(req, res, false);
  }

  /** Compat checker : pas de méthode privée (#) */
  static async _togglePublic(req, res, makePublic) {
    try {
      const userIdStr = await authUserId(req);
      if (!userIdStr) return res.status(401).json({ error: 'Unauthorized' });

      let fileId;
      try { fileId = new ObjectId(req.params.id); } catch { return res.status(404).json({ error: 'Not found' }); }

      const filesCol = dbClient.db.collection('files');
      const filter = { _id: fileId, userId: new ObjectId(userIdStr) };

      const upd = await filesCol.updateOne(filter, { $set: { isPublic: !!makePublic } });
      if (!upd.matchedCount) return res.status(404).json({ error: 'Not found' });

      const file = await filesCol.findOne(filter);
      return res.status(200).json({
        id: file._id.toString(),
        userId: file.userId.toString(),
        name: file.name,
        type: file.type,
        isPublic: !!file.isPublic,
        parentId: normalizeParentIdForResponse(file.parentId),
      });
    } catch {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  /** Task 8 (+9): GET /files/:id/data (support du param size) */
  static async getFile(req, res) {
    try {
      // 1) Chercher le document par ID
      let fileId;
      try { fileId = new ObjectId(req.params.id); } catch { return res.status(404).json({ error: 'Not found' }); }

      const filesCol = dbClient.db.collection('files');
      const file = await filesCol.findOne({ _id: fileId });
      if (!file) return res.status(404).json({ error: 'Not found' });

      // 2) Autorisations: si non public => il faut être authentifié ET propriétaire
      if (!file.isPublic) {
        const userIdStr = await authUserId(req);
        if (!userIdStr) return res.status(404).json({ error: 'Not found' }); // spec: 404, pas 401
        if (file.userId?.toString() !== userIdStr) return res.status(404).json({ error: 'Not found' });
      }

      // 3) Dossier => 400
      if (file.type === 'folder') {
        return res.status(400).json({ error: "A folder doesn't have content" });
      }

      // 4) Chemin local (support du size = 100 | 250 | 500)
      if (!file.localPath) return res.status(404).json({ error: 'Not found' });
      const size = parseInt(req.query.size, 10);
      const allowed = [100, 250, 500];
      let localPath = file.localPath;
      if (allowed.includes(size)) {
        localPath = `${file.localPath}_${size}`;
      }

      try {
        await fs.access(localPath);
      } catch {
        return res.status(404).json({ error: 'Not found' });
      }

      const contentType = mime.lookup(file.name) || 'application/octet-stream';
      const data = await fs.readFile(localPath);
      res.setHeader('Content-Type', contentType);
      return res.status(200).send(data);
    } catch {
      return res.status(500).json({ error: 'Server error' });
    }
  }
}
