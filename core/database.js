const mongoose = require('mongoose');
const config = require('../config');
const logger = require('./logger');

// Contact Schema
const contactSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    phone: { type: String, required: true },
    profilePicUrl: { type: String, default: '' },
    isGroup: { type: Boolean, default: false },
    groupSubject: { type: String, default: '' },
    lastSeen: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    tags: [{ type: String }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Topic Mapping Schema
const topicMappingSchema = new mongoose.Schema({
    whatsappJid: { type: String, required: true, unique: true },
    telegramTopicId: { type: Number, required: true },
    topicName: { type: String, required: true },
    isGroup: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    messageCount: { type: Number, default: 0 },
    lastActivity: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

// Bridge Settings Schema
const bridgeSettingsSchema = new mongoose.Schema({
    settingKey: { type: String, required: true, unique: true },
    settingValue: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now }
});

// Message Log Schema
const messageLogSchema = new mongoose.Schema({
    whatsappMessageId: { type: String, required: true },
    telegramMessageId: { type: Number },
    whatsappJid: { type: String, required: true },
    telegramTopicId: { type: Number, required: true },
    messageType: { type: String, enum: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'voice'], default: 'text' },
    content: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    direction: { type: String, enum: ['wa_to_tg', 'tg_to_wa'], required: true },
    timestamp: { type: Date, default: Date.now }
});

const Contact = mongoose.model('Contact', contactSchema);
const TopicMapping = mongoose.model('TopicMapping', topicMappingSchema);
const BridgeSettings = mongoose.model('BridgeSettings', bridgeSettingsSchema);
const MessageLog = mongoose.model('MessageLog', messageLogSchema);

class Database {
    constructor() {
        this.isConnected = false;
    }

    async connect() {
        if (!config.get('database.mongodb.enabled')) {
            logger.info('📊 MongoDB disabled in config');
            return;
        }

        try {
            const uri = config.get('database.mongodb.uri');
            const options = config.get('database.mongodb.options');
            
            await mongoose.connect(uri, options);
            this.isConnected = true;
            logger.info('📊 Connected to MongoDB');
            
            // Initialize default settings
            await this.initializeSettings();
        } catch (error) {
            logger.error('❌ MongoDB connection failed:', error);
        }
    }

    async initializeSettings() {
        const defaultSettings = [
            { settingKey: 'bridge_enabled', settingValue: true, description: 'Enable/disable bridge' },
            { settingKey: 'allow_media', settingValue: true, description: 'Allow media forwarding' },
            { settingKey: 'allow_stickers', settingValue: true, description: 'Allow sticker forwarding' },
            { settingKey: 'sync_contacts', settingValue: true, description: 'Sync contact names' },
            { settingKey: 'sync_status', settingValue: true, description: 'Sync status updates' }
        ];

        for (const setting of defaultSettings) {
            await BridgeSettings.findOneAndUpdate(
                { settingKey: setting.settingKey },
                setting,
                { upsert: true, new: true }
            );
        }
    }

    async disconnect() {
        if (this.isConnected) {
            await mongoose.disconnect();
            this.isConnected = false;
            logger.info('📊 Disconnected from MongoDB');
        }
    }

    // Contact methods
    async saveContact(contactData) {
        try {
            return await Contact.findOneAndUpdate(
                { jid: contactData.jid },
                { ...contactData, updatedAt: new Date() },
                { upsert: true, new: true }
            );
        } catch (error) {
            logger.error('❌ Error saving contact:', error);
            return null;
        }
    }

    async getContact(jid) {
        try {
            return await Contact.findOne({ jid });
        } catch (error) {
            logger.error('❌ Error getting contact:', error);
            return null;
        }
    }

    async getAllContacts() {
        try {
            return await Contact.find({}).sort({ lastSeen: -1 });
        } catch (error) {
            logger.error('❌ Error getting contacts:', error);
            return [];
        }
    }

    // Topic mapping methods
    async saveTopicMapping(mappingData) {
        try {
            return await TopicMapping.findOneAndUpdate(
                { whatsappJid: mappingData.whatsappJid },
                mappingData,
                { upsert: true, new: true }
            );
        } catch (error) {
            logger.error('❌ Error saving topic mapping:', error);
            return null;
        }
    }

    async getTopicMapping(whatsappJid) {
        try {
            return await TopicMapping.findOne({ whatsappJid });
        } catch (error) {
            logger.error('❌ Error getting topic mapping:', error);
            return null;
        }
    }

    async getAllTopicMappings() {
        try {
            return await TopicMapping.find({}).sort({ lastActivity: -1 });
        } catch (error) {
            logger.error('❌ Error getting topic mappings:', error);
            return [];
        }
    }

    // Settings methods
    async getSetting(key) {
        try {
            const setting = await BridgeSettings.findOne({ settingKey: key });
            return setting ? setting.settingValue : null;
        } catch (error) {
            logger.error('❌ Error getting setting:', error);
            return null;
        }
    }

    async setSetting(key, value, description = '') {
        try {
            return await BridgeSettings.findOneAndUpdate(
                { settingKey: key },
                { settingValue: value, description, updatedAt: new Date() },
                { upsert: true, new: true }
            );
        } catch (error) {
            logger.error('❌ Error setting value:', error);
            return null;
        }
    }

    // Message log methods
    async logMessage(messageData) {
        try {
            const messageLog = new MessageLog(messageData);
            return await messageLog.save();
        } catch (error) {
            logger.error('❌ Error logging message:', error);
            return null;
        }
    }
}

module.exports = { Database, Contact, TopicMapping, BridgeSettings, MessageLog };
