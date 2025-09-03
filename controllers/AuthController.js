// controllers/AuthController.js
import { ObjectId } from 'mongodb';
import sha1 from 'sha1';
import { v4 as uuidv4 } from 'uuid';
import dbClient from '../utils/db.mjs';
import redisClient from '../utils/redis.mjs';

function decodeBasicAuth(header) {
  // header like: "Basic xxxxxxxxx"
  if (!header || !header.startsWith('Basic ')) return null;
  const b64 = header.replace('Basic ', '');
  const decoded = Buffer.from(b64, 'base64').toString('utf-8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return { email: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

class AuthController {
  static async getConnect(req, res) {
    const decoded = decodeBasicAuth(req.header('Authorization'));
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const { email, password } = decoded;
    const user = await dbClient.collection('users').findOne({ email, password: sha1(password) });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const token = uuidv4();
    const key = `auth_${token}`;
    await redisClient.set(key, user._id.toString(), 24 * 3600);
    return res.status(200).json({ token });
  }

  static async getDisconnect(req, res) {
    const token = req.header('X-Token');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const val = await redisClient.get(`auth_${token}`);
    if (!val) return res.status(401).json({ error: 'Unauthorized' });

    await redisClient.del(`auth_${token}`);
    return res.status(204).send();
  }
}

export default AuthController;
