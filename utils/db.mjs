// utils/db.mjs
import { MongoClient } from 'mongodb';

class DBClient {
  constructor() {
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || 27017;
    const database = process.env.DB_DATABASE || 'files_manager';
    const url = `mongodb://${host}:${port}`;

    this.client = new MongoClient(url, { useUnifiedTopology: true });
    this.connected = false;
    this.client.connect()
      .then(() => {
        this.db = this.client.db(database);
        this.connected = true;
      })
      .catch((err) => {
        console.error('MongoDB connection error:', err);
        this.connected = false;
      });
  }

  isAlive() {
    return this.connected;
  }

  collection(name) {
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
