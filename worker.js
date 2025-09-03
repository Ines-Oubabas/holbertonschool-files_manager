// worker.js
import fs from 'fs';
import path from 'path';
import imageThumbnail from 'image-thumbnail';
import Queue from 'bull';
import { ObjectId } from 'mongodb';
import dbClient from './utils/db';

const fileQueue = new Queue('fileQueue');

fileQueue.process(async (job, done) => {
  try {
    const { fileId, userId } = job.data || {};
    if (!fileId) throw new Error('Missing fileId');
    if (!userId) throw new Error('Missing userId');

    const file = await dbClient.collection('files').findOne({
      _id: new ObjectId(fileId),
      userId: new ObjectId(userId),
    });
    if (!file) throw new Error('File not found');
    if (!file.localPath || !fs.existsSync(file.localPath)) throw new Error('File not found');

    const sizes = [500, 250, 100];
    // Generate thumbnails
    // image-thumbnail returns a Buffer
    /* eslint-disable no-restricted-syntax */
    for (const width of sizes) {
      const options = { width };
      const thumbnail = await imageThumbnail(file.localPath, options);
      const thumbPath = `${file.localPath}_${width}`;
      fs.writeFileSync(thumbPath, thumbnail);
    }
    /* eslint-enable no-restricted-syntax */

    return done();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Worker error:', err.message || err);
    return done(err);
  }
});
