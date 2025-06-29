const logger = require('../utils/logger');
const WhatsAppMessageSyncDetector = require('./message-sync');

class MessageHandler {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.commandHandlers = new Map();
        this.messageFilters = new Map();
        this.syncDetector = null;
        
        // Initialize sync detector when Telegram bridge is available
        this.initializeSyncDetector();
    }

    initializeSyncDetector() {
        // Wait for Telegram bridge to be initialized
        setTimeout(() => {
            if (this.whatsappBot.telegramBridge) {
                this.syncDetector = new WhatsAppMessageSyncDetector(
                    this.whatsappBot, 
                    this.whatsappBot.telegramBridge
                );
                logger.info('✅ Message sync detector initialized');
            }
        }, 2000);
    }

    /**
     * Main message handler - processes all incoming WhatsApp messages
     */
    async handleMessages(m) {
        try {
            const messages = m.messages;
            if (!messages || messages.length === 0) return;

            for (const message of messages) {
                await this.processIncomingMessage(message, m.type);
            }
            
        } catch (error) {
            logger.error('❌ Error in handleMessages:', error);
        }
    }

    /**
     * Process individual incoming message
     */
    async processIncomingMessage(message, messageType) {
        try {
            logger.info('📨 INCOMING WhatsApp message detected');
            logger.info(`📱 From: ${message.key?.remoteJid || 'unknown'}`);
            logger.info(`🔑 Message ID: ${message.key?.id || 'unknown'}`);
            logger.info(`⏰ Type: ${messageType}`);
            
            // Log message structure for debugging
            this.logMessageStructure(message);
            
            // Detect and sync message if sync detector is available
            if (this.syncDetector) {
                logger.info('🔄 Attempting to sync message...');
                const syncResult = await this.syncDetector.detectAndSyncMessage(message, messageType);
                
                if (syncResult) {
                    logger.info('✅ Message sync initiated successfully');
                } else {
                    logger.warn('⚠️ Message sync failed or skipped');
                }
                
                // Log sync stats
                const stats = this.syncDetector.getSyncStats();
                logger.info(`📊 Sync Stats: ${JSON.stringify(stats, null, 2)}`);
            } else {
                logger.warn('⚠️ Sync detector not available, message not synced');
            }
            
            // Process commands if it's a text message
            await this.processCommands(message);
            
            // Apply message filters
            await this.applyMessageFilters(message);
            
        } catch (error) {
            logger.error('❌ Error processing incoming message:', error);
        }
    }

    /**
     * Log message structure for debugging
     */
    logMessageStructure(message) {
        logger.info('🔍 MESSAGE STRUCTURE ANALYSIS:');
        logger.info(`📋 Top-level keys: ${Object.keys(message).join(', ')}`);
        
        if (message.message) {
            logger.info(`💬 Message content keys: ${Object.keys(message.message).join(', ')}`);
            
            // Check for specific message types
            const messageTypes = [
                'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
                'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage',
                'contactMessage', 'reactionMessage', 'pollCreationMessage'
            ];
            
            messageTypes.forEach(type => {
                if (message.message[type]) {
                    logger.info(`✅ DETECTED: ${type}`);
                    if (typeof message.message[type] === 'object') {
                        const keys = Object.keys(message.message[type]);
                        logger.info(`   📊 ${type} properties: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`);
                    }
                }
            });
        }
        
        if (message.key) {
            logger.info(`🔑 Key info: remoteJid=${message.key.remoteJid}, fromMe=${message.key.fromMe}, id=${message.key.id}`);
        }
        
        if (message.messageTimestamp) {
            logger.info(`⏰ Timestamp: ${new Date(message.messageTimestamp * 1000).toISOString()}`);
        }
    }

    /**
     * Process commands from text messages
     */
    async processCommands(message) {
        try {
            let text = '';
            
            if (message.message?.conversation) {
                text = message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                text = message.message.extendedTextMessage.text;
            }
            
            if (!text || !text.startsWith(this.whatsappBot.config?.bot?.prefix || '.')) {
                return;
            }
            
            const args = text.slice(1).split(' ');
            const command = args.shift().toLowerCase();
            
            if (this.commandHandlers.has(command)) {
                logger.info(`🎯 Executing command: ${command}`);
                const handler = this.commandHandlers.get(command);
                await handler.execute(message, args, this.whatsappBot);
            }
            
        } catch (error) {
            logger.error('❌ Error processing commands:', error);
        }
    }

    /**
     * Apply message filters
     */
    async applyMessageFilters(message) {
        try {
            for (const [filterName, filter] of this.messageFilters) {
                if (await filter.shouldProcess(message)) {
                    await filter.process(message, this.whatsappBot);
                }
            }
        } catch (error) {
            logger.error('❌ Error applying message filters:', error);
        }
    }

    /**
     * Register command handler
     */
    registerCommandHandler(command, handler) {
        this.commandHandlers.set(command.toLowerCase(), handler);
        logger.info(`📝 Registered command handler: ${command}`);
    }

    /**
     * Register message filter
     */
    registerMessageFilter(name, filter) {
        this.messageFilters.set(name, filter);
        logger.info(`🔍 Registered message filter: ${name}`);
    }

    /**
     * Get sync detector instance
     */
    getSyncDetector() {
        return this.syncDetector;
    }

    /**
     * Force sync a specific message
     */
    async forceSyncMessage(message, messageType = 'notify') {
        if (!this.syncDetector) {
            throw new Error('Sync detector not available');
        }
        
        logger.info('🔄 FORCE SYNCING message...');
        return await this.syncDetector.detectAndSyncMessage(message, messageType);
    }
}

module.exports = MessageHandler;
