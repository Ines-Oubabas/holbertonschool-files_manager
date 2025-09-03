// utils/db.mjs
import mongodb from 'mongodb';

const { MongoClient } = mongodb;

class DBClient {
  constructor() {
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || 27017;
    const database = process.env.DB_DATABASE || 'files_manager';
    const url = `mongodb://${host}:${port}`;

    this.dbName = database;
    this.client = new MongoClient(url, { useUnifiedTopology: true });
    this.connected = false;

    this.client.connect()
      .then(() => {
        this.db = this.client.db(this.dbName);
        this.connected = true;
      })
      .catch((err) => {
        console.error('MongoDB connection error:', err.message || err);
        this.connected = false;
      });
  }

  isAlive() {
    return this.connected;
  }

  collection(name) {
    if (!this.db) return null;
    return this.db.collection(name);
  }

  async nbUsers() {
    return this.collection('users').countDocuments();
  }

  async nbFiles() {
    return this.collection('files').countDocuments();
  }
}

const dbClient = new DBClient();
export default dbClient;
