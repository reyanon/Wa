const mongoose = require('mongoose');
const logger = require('../../core/logger');

// Schema definitions
const ContactSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    name: { type: String, default: '' },
    pushName: { type: String, default: '' },
    profilePicture: { type: String, default: '' },
    isGroup: { type: Boolean, default: false },
    groupName: { type: String, default: '' },
    firstSeen: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },
    notes: { type: String, default: '' }
});

const ChatMappingSchema = new mongoose.Schema({
    whatsappJid: { type: String, required: true, unique: true },
    telegramTopicId: { type: Number, required: true },
    chatType: { type: String, enum: ['private', 'group'], required: true },
    topicName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
});

const MessageSchema = new mongoose.Schema({
    whatsappMessageId: { type: String, required: true },
    telegramMessageId: { type: Number },
    whatsappJid: { type: String, required: true },
    telegramTopicId: { type: Number, required: true },
    messageType: { type: String, required: true },
    content: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
    isFromWhatsApp: { type: Boolean, default: true },
    processingStatus: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' }
});

const SettingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, default: Date.now }
});

const StatusUpdateSchema = new mongoose.Schema({
    contactJid: { type: String, required: true },
    statusId: { type: String, required: true },
    content: { type: String, default: '' },
    mediaType: { type: String, default: 'text' },
    mediaUrl: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
    viewedAt: { type: Date }
});

const CallLogSchema = new mongoose.Schema({
    contactJid: { type: String, required: true },
    callType: { type: String, enum: ['voice', 'video'], required: true },
    direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
    duration: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now },
    status: { type: String, enum: ['answered', 'missed', 'rejected'], required: true }
});

class DatabaseManager {
    constructor() {
        this.isConnected = false;
        this.models = {};
    }

    async initialize() {
        try {
            // Connect to MongoDB
            const mongoUri = 'mongodb+srv://itxelijah07:ivp8FYGsbVfjQOkj@cluster0.wh25x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
            
            await mongoose.connect(mongoUri, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
            });

            // Register models
            this.models.Contact = mongoose.model('Contact', ContactSchema);
            this.models.ChatMapping = mongoose.model('ChatMapping', ChatMappingSchema);
            this.models.Message = mongoose.model('Message', MessageSchema);
            this.models.Settings = mongoose.model('Settings', SettingsSchema);
            this.models.StatusUpdate = mongoose.model('StatusUpdate', StatusUpdateSchema);
            this.models.CallLog = mongoose.model('CallLog', CallLogSchema);

            this.isConnected = true;
            logger.info('✅ Database connected successfully');
            
            // Create indexes for better performance
            await this.createIndexes();
            
        } catch (error) {
            logger.error('❌ Database connection failed:', error);
            throw error;
        }
    }

    async createIndexes() {
        try {
            await this.models.Contact.createIndex({ phone: 1 });
            await this.models.Contact.createIndex({ lastActive: -1 });
            await this.models.ChatMapping.createIndex({ telegramTopicId: 1 });
            await this.models.Message.createIndex({ whatsappJid: 1, timestamp: -1 });
            await this.models.Message.createIndex({ processingStatus: 1 });
            await this.models.StatusUpdate.createIndex({ contactJid: 1, timestamp: -1 });
            await this.models.CallLog.createIndex({ contactJid: 1, timestamp: -1 });
            
            logger.info('📊 Database indexes created');
        } catch (error) {
            logger.error('Failed to create indexes:', error);
        }
    }

    // Contact operations
    async saveContact(contactData) {
        try {
            const contact = await this.models.Contact.findOneAndUpdate(
                { jid: contactData.jid },
                { 
                    ...contactData,
                    lastActive: new Date()
                },
                { upsert: true, new: true }
            );
            return contact;
        } catch (error) {
            logger.error('Failed to save contact:', error);
            throw error;
        }
    }

    async getContact(jid) {
        try {
            return await this.models.Contact.findOne({ jid });
        } catch (error) {
            logger.error('Failed to get contact:', error);
            return null;
        }
    }

    async getAllContacts() {
        try {
            return await this.models.Contact.find().sort({ lastActive: -1 });
        } catch (error) {
            logger.error('Failed to get all contacts:', error);
            return [];
        }
    }

    async updateContactMessageCount(jid) {
        try {
            await this.models.Contact.findOneAndUpdate(
                { jid },
                { 
                    $inc: { messageCount: 1 },
                    lastActive: new Date()
                }
            );
        } catch (error) {
            logger.error('Failed to update contact message count:', error);
        }
    }

    // Chat mapping operations
    async saveChatMapping(mappingData) {
        try {
            const mapping = await this.models.ChatMapping.findOneAndUpdate(
                { whatsappJid: mappingData.whatsappJid },
                mappingData,
                { upsert: true, new: true }
