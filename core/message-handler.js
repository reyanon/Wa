const logger = require('./logger');
const config = require('../config');

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.commandHandlers = new Map();
        this.rateLimiter = new Map();
    }

    registerCommandHandler(command, handler) {
        this.commandHandlers.set(command, handler);
        logger.debug(`📝 Registered command handler: ${command}`);
    }

    async handleMessages(m) {
        try {
            const messages = m.messages;
            
            for (const message of messages) {
                if (!message.message) continue;
                
                // Extract message text
                const text = this.extractMessageText(message);
                
                // Handle commands if it's a text message with prefix
                if (text && text.startsWith(config.get('bot.prefix'))) {
                    await this.handleCommand(message, text);
                    continue; // Don't sync command messages
                }
                
                // Sync to Telegram bridge
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.syncMessage(message, text);
                }
                
                // Handle status updates
                if (message.key.remoteJid === 'status@broadcast' && config.get('telegram.settings.syncStatus')) {
                    await this.handleStatusUpdate(message);
                }
                
                // Handle calls
                if (message.messageStubType && this.isCallMessage(message) && config.get('telegram.settings.syncCalls')) {
                    await this.handleCallMessage(message);
                }
                
                // Handle profile picture updates
                if (message.messageStubType === 5 && config.get('telegram.settings.autoUpdateProfilePics')) { // Profile picture changed
                    await this.handleProfilePictureUpdate(message);
                }
            }
        } catch (error) {
            logger.error('❌ Error handling messages:', error);
        }
    }

    extractMessageText(message) {
        if (message.message?.conversation) {
            return message.message.conversation;
        } else if (message.message?.extendedTextMessage?.text) {
            return message.message.extendedTextMessage.text;
        } else if (message.message?.imageMessage?.caption) {
            return message.message.imageMessage.caption;
        } else if (message.message?.videoMessage?.caption) {
            return message.message.videoMessage.caption;
        }
        return null;
    }

    async handleCommand(message, text) {
        const args = text.slice(config.get('bot.prefix').length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        
        const handler = this.commandHandlers.get(command);
        if (handler) {
            try {
                await handler.execute(message, args, this.bot);
            } catch (error) {
                logger.error(`❌ Error executing command ${command}:`, error);
            }
        }
    }

    async handleStatusUpdate(message) {
        if (!this.bot.telegramBridge) return;
        
        try {
            const sender = message.key.participant || message.key.remoteJid;
            const text = this.extractMessageText(message);
            
            // Create a status update message with special JID
            const statusMessage = {
                ...message,
                key: {
                    ...message.key,
                    remoteJid: 'status@broadcast'
                }
            };
            
            await this.bot.telegramBridge.syncMessage(statusMessage, text || 'Status update');
        } catch (error) {
            logger.error('❌ Error handling status update:', error);
        }
    }

    isCallMessage(message) {
        const callTypes = [1, 2, 3, 4, 5]; // Various call message types
        return callTypes.includes(message.messageStubType);
    }

    async handleCallMessage(message) {
        if (!this.bot.telegramBridge) return;
        
        try {
            const callType = this.getCallType(message.messageStubType);
            const participant = message.key.participant || message.key.remoteJid;
            
            // Create a call message with special JID
            const callMessage = {
                ...message,
                key: {
                    ...message.key,
                    remoteJid: 'call@broadcast'
                }
            };
            
            await this.bot.telegramBridge.syncMessage(callMessage, `${callType} call from ${participant.split('@')[0]}`);
        } catch (error) {
            logger.error('❌ Error handling call message:', error);
        }
    }

    getCallType(stubType) {
        switch (stubType) {
            case 1: return 'Missed';
            case 2: return 'Outgoing';
            case 3: return 'Incoming';
            case 4: return 'Video';
            default: return 'Unknown';
        }
    }

    async handleProfilePictureUpdate(message) {
        if (!this.bot.telegramBridge) return;
        
        try {
            const participant = message.key.participant || message.key.remoteJid;
            const topicId = this.bot.telegramBridge.chatMappings.get(participant);
            
            if (topicId) {
                await this.bot.telegramBridge.sendProfilePicture(topicId, participant, true);
            }
        } catch (error) {
            logger.error('❌ Error handling profile picture update:', error);
        }
    }
}

module.exports = MessageHandler;
