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

    this.connectPromise = this.client.connect()
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

  async collection(name) {
    // Attendre la connexion si pas encore prête
    if (!this.connected) {
      await this.connectPromise;
    }
    return this.db.collection(name);
  }

  async nbUsers() {
    const users = await this.collection('users');
    return users.countDocuments();
  }

  async nbFiles() {
    const files = await this.collection('files');
    return files.countDocuments();
  }
}

const dbClient = new DBClient();
export default dbClient;
