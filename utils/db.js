const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../core/logger');

/**
 * Simple Database Manager for NexusWA
 */
class DatabaseManager {
    constructor() {
        this.connection = null;
        this.isConnected = false;
    }

    /**
     * Connect to MongoDB database
     */
    async connect() {
        try {
            const uri = config.get('mongo.uri');
            const dbName = config.get('mongo.dbName');
            
            logger.info('🔌 Connecting to MongoDB...');
            
            this.connection = await mongoose.connect(uri, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
                dbName: dbName
            });
            
            this.isConnected = true;
            logger.info('✅ Database connected successfully');
            
            return this.connection;
        } catch (error) {
            logger.error('❌ Database connection failed:', error);
            throw error;
        }
    }

    /**
     * Disconnect from database
     */
    async disconnect() {
        try {
            if (this.connection) {
                await mongoose.disconnect();
                this.isConnected = false;
                logger.info('📴 Database disconnected');
            }
        } catch (error) {
            logger.error('❌ Error disconnecting from database:', error);
        }
    }

    /**
     * Check if database is connected
     */
    isConnectedToDatabase() {
        return this.isConnected && mongoose.connection.readyState === 1;
    }
}

// Export singleton instance
module.exports = new DatabaseManager();
