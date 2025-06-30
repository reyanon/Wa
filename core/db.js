const { MongoClient } = require('mongodb');
const config = require('../config'); // Assuming config is one level up relative to where db.js is

let _db; // Private variable to hold the database instance

async function connectDb() {
    if (_db) {
        // If connection already exists, return it
        return _db;
    }

    const dbUri = config.get('mongodb.uri');
    const dbName = config.get('mongodb.dbName'); // <<< Ensure you have a 'dbName' in your config

    if (!dbUri || !dbName || dbUri.includes('YOUR_MONGODB_URI')) {
        throw new Error('MongoDB URI or DB name not configured in config.js');
    }

    try {
        const client = new MongoClient(dbUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        await client.connect();
        _db = client.db(dbName); // Connect to the specific database name
        console.log(`📊 Connected to MongoDB: ${dbName}`);
        return _db;
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error);
        throw error;
    }
}

function getDb() {
    if (!_db) {
        throw new Error('Database not connected. Call connectDb() first.');
    }
    return _db;
}

module.exports = {
    connectDb,
    getDb,
};
