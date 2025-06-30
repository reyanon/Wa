const { MongoClient } = require('mongodb');

const MONGO_URI = config.get('database.mongodb.uri');
const DB_NAME = config.get('database.mongodb.dbName') || 'nexuswa';
const OPTIONS = config.get('database.mongodb.options') || {
    useNewUrlParser: true,
    useUnifiedTopology: true
};

const client = new MongoClient(MONGO_URI, OPTIONS);

async function connectDb() {
    if (!client.topology?.isConnected?.()) {
        await client.connect();
    }
    return client.db(DB_NAME);
}

function useCollection(name) {
    return async () => {
        const db = await connectDb();
        return db.collection(name);
    };
}

module.exports = { connectDb, useCollection };
