import pkg from "mongodb";
const { MongoClient } = pkg;

class DBClient {
  constructor() {
    const host = process.env.DB_HOST || "localhost";
    const port = process.env.DB_PORT || 27017;
    const database = process.env.DB_DATABASE || "files_manager";
    const url = `mongodb://${host}:${port}`;

    this.client = new MongoClient(url, { useUnifiedTopology: true });
    this.dbName = database;
    this.db = null;

    // On ouvre la connexion au démarrage
    this.client
      .connect()
      .then(() => {
        this.db = this.client.db(this.dbName);
      })
      .catch((err) => {
        console.error("MongoDB connection error:", err);
      });
  }

  isAlive() {
    // alive si client connecté ET db initialisée
    return (
      this.client &&
      this.client.isConnected &&
      this.client.isConnected() &&
      this.db !== null
    );
  }

  async nbUsers() {
    if (!this.db) return 0;
    return this.db.collection("users").countDocuments();
  }

  async nbFiles() {
    if (!this.db) return 0;
    return this.db.collection("files").countDocuments();
  }
}

const dbClient = new DBClient();
export default dbClient;
