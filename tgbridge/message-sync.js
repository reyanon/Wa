const logger = require('../utils/logger');
const config = require('../../config');

class WhatsAppMessageSyncDetector {
    constructor(whatsappBot, telegramBridge) {
        this.whatsappBot = whatsappBot;
        this.telegramBridge = telegramBridge;
        this.messageQueue = new Map();
        this.processingQueue = false;
        this.syncStats = {
            totalMessages: 0,
            processedMessages: 0,
            failedMessages: 0,
            mediaMessages: 0,
            textMessages: 0
        };
    }

    /**
     * Main function to detect and sync incoming WhatsApp messages
     */
    async detectAndSyncMessage(message, messageType) {
        try {
            logger.info('🔍 DETECTING WhatsApp message for sync...');
            
            // Log raw message for debugging
            this.logRawMessage(message, messageType);
            
            // Validate message
            if (!this.validateMessage(message)) {
                logger.warn('⚠️ Invalid message structure, skipping sync');
                return false;
            }

            // Extract message info
            const messageInfo = await this.extractMessageInfo(message, messageType);
            if (!messageInfo) {
                logger.warn('⚠️ Could not extract message info, skipping sync');
                return false;
            }

            // Add to processing queue
            await this.queueMessageForSync(messageInfo);
            
            // Process queue
            await this.processMessageQueue();
            
            return true;
            
        } catch (error) {
            logger.error('❌ Error in detectAndSyncMessage:', error);
            this.syncStats.failedMessages++;
            return false;
        }
    }

    /**
     * Log raw message structure for debugging
     */
    logRawMessage(message, messageType) {
        logger.info('📋 RAW MESSAGE DETECTION:');
        logger.info(`📱 Message Type: ${messageType}`);
        logger.info(`🔑 Message Keys: ${Object.keys(message).join(', ')}`);
        
        // Log message content structure
        if (message.message) {
            logger.info(`💬 Message Content Keys: ${Object.keys(message.message).join(', ')}`);
            
            // Check for each media type
            const mediaTypes = [
                'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
                'stickerMessage', 'locationMessage', 'contactMessage', 'conversation',
                'extendedTextMessage', 'quotedMessage'
            ];
            
            mediaTypes.forEach(type => {
                if (message.message[type]) {
                    logger.info(`✅ FOUND: ${type}`);
                    if (typeof message.message[type] === 'object') {
                        logger.info(`   📊 ${type} properties: ${Object.keys(message.message[type]).join(', ')}`);
                    }
                }
            });
        }
    }

    /**
     * Validate message structure
     */
    validateMessage(message) {
        if (!message) {
            logger.warn('❌ Message is null or undefined');
            return false;
        }

        if (!message.key) {
            logger.warn('❌ Message missing key property');
            return false;
        }

        if (!message.key.remoteJid) {
            logger.warn('❌ Message missing remoteJid');
            return false;
        }

        if (!message.message && !message.messageStubType) {
            logger.warn('❌ Message missing content');
            return false;
        }

        logger.info('✅ Message validation passed');
        return true;
    }

    /**
     * Extract comprehensive message information
     */
    async extractMessageInfo(message, messageType) {
        try {
            logger.info('🔍 EXTRACTING message information...');
            
            const messageInfo = {
                // Basic info
                id: message.key.id,
                remoteJid: message.key.remoteJid,
                fromMe: message.key.fromMe || false,
                timestamp: message.messageTimestamp || Date.now(),
                
                // Message type detection
                messageType: this.detectMessageType(message),
                originalType: messageType,
                
                // Content
                content: null,
                mediaInfo: null,
                
                // Metadata
                isGroup: message.key.remoteJid.endsWith('@g.us'),
                participant: message.key.participant || null,
                pushName: message.pushName || 'Unknown',
                
                // Status
                processed: false,
                syncedToTelegram: false,
                error: null
            };

            // Extract content based on message type
            await this.extractMessageContent(message, messageInfo);
            
            logger.info(`📊 Extracted message info: ${JSON.stringify({
                id: messageInfo.id,
                type: messageInfo.messageType,
                from: messageInfo.remoteJid,
                hasContent: !!messageInfo.content,
                hasMedia: !!messageInfo.mediaInfo
            }, null, 2)}`);
            
            return messageInfo;
            
        } catch (error) {
            logger.error('❌ Error extracting message info:', error);
            return null;
        }
    }

    /**
     * Detect the actual message type from message object
     */
    detectMessageType(message) {
        if (!message.message) {
            if (message.messageStubType) {
                return 'system';
            }
            return 'unknown';
        }

        const msg = message.message;
        
        // Check for each message type in priority order
        if (msg.imageMessage) return 'image';
        if (msg.videoMessage) return 'video';
        if (msg.audioMessage) return 'audio';
        if (msg.documentMessage) return 'document';
        if (msg.stickerMessage) return 'sticker';
        if (msg.locationMessage) return 'location';
        if (msg.contactMessage) return 'contact';
        if (msg.conversation) return 'text';
        if (msg.extendedTextMessage) return 'extendedText';
        if (msg.quotedMessage) return 'quoted';
        if (msg.reactionMessage) return 'reaction';
        if (msg.pollCreationMessage) return 'poll';
        if (msg.pollUpdateMessage) return 'pollUpdate';
        
        logger.warn(`⚠️ Unknown message type. Available keys: ${Object.keys(msg).join(', ')}`);
        return 'unknown';
    }

    /**
     * Extract content based on message type
     */
    async extractMessageContent(message, messageInfo) {
        const msg = message.message;
        const type = messageInfo.messageType;
        
        logger.info(`🔍 EXTRACTING CONTENT for type: ${type}`);
        
        try {
            switch (type) {
                case 'text':
                    messageInfo.content = {
                        text: msg.conversation || '',
                        type: 'text'
                    };
                    this.syncStats.textMessages++;
                    break;
                    
                case 'extendedText':
                    messageInfo.content = {
                        text: msg.extendedTextMessage?.text || '',
                        contextInfo: msg.extendedTextMessage?.contextInfo,
                        type: 'extendedText'
                    };
                    this.syncStats.textMessages++;
                    break;
                    
                case 'image':
                    messageInfo.content = {
                        caption: msg.imageMessage?.caption || '',
                        type: 'image'
                    };
                    messageInfo.mediaInfo = await this.extractMediaInfo(msg.imageMessage, 'image');
                    this.syncStats.mediaMessages++;
                    break;
                    
                case 'video':
                    messageInfo.content = {
                        caption: msg.videoMessage?.caption || '',
                        type: 'video'
                    };
                    messageInfo.mediaInfo = await this.extractMediaInfo(msg.videoMessage, 'video');
                    this.syncStats.mediaMessages++;
                    break;
                    
                case 'audio':
                    messageInfo.content = {
                        type: 'audio',
                        ptt: msg.audioMessage?.ptt || false
                    };
                    messageInfo.mediaInfo = await this.extractMediaInfo(msg.audioMessage, 'audio');
                    this.syncStats.mediaMessages++;
                    break;
                    
                case 'document':
                    messageInfo.content = {
                        caption: msg.documentMessage?.caption || '',
                        fileName: msg.documentMessage?.fileName || 'document',
                        type: 'document'
                    };
                    messageInfo.mediaInfo = await this.extractMediaInfo(msg.documentMessage, 'document');
                    this.syncStats.mediaMessages++;
                    break;
                    
                case 'sticker':
                    messageInfo.content = {
                        type: 'sticker',
                        isAnimated: msg.stickerMessage?.isAnimated || false
                    };
                    messageInfo.mediaInfo = await this.extractMediaInfo(msg.stickerMessage, 'sticker');
                    this.syncStats.mediaMessages++;
                    break;
                    
                case 'location':
                    messageInfo.content = {
                        type: 'location',
                        latitude: msg.locationMessage?.degreesLatitude,
                        longitude: msg.locationMessage?.degreesLongitude,
                        name: msg.locationMessage?.name || ''
                    };
                    break;
                    
                case 'contact':
                    messageInfo.content = {
                        type: 'contact',
                        displayName: msg.contactMessage?.displayName || '',
                        vcard: msg.contactMessage?.vcard || ''
                    };
                    break;
                    
                case 'reaction':
                    messageInfo.content = {
                        type: 'reaction',
                        emoji: msg.reactionMessage?.text || '',
                        targetMessageId: msg.reactionMessage?.key?.id
                    };
                    break;
                    
                default:
                    logger.warn(`⚠️ Unhandled message type: ${type}`);
                    messageInfo.content = {
                        type: 'unknown',
                        raw: msg
                    };
            }
            
            logger.info(`✅ Content extracted for ${type}: ${JSON.stringify(messageInfo.content, null, 2)}`);
            
        } catch (error) {
            logger.error(`❌ Error extracting content for ${type}:`, error);
            messageInfo.error = error.message;
        }
    }

    /**
     * Extract media information
     */
    async extractMediaInfo(mediaMessage, mediaType) {
        if (!mediaMessage) {
            logger.warn(`⚠️ No media message object for type: ${mediaType}`);
            return null;
        }

        logger.info(`🔍 EXTRACTING MEDIA INFO for ${mediaType}:`);
        logger.info(`📊 Media object keys: ${Object.keys(mediaMessage).join(', ')}`);

        const mediaInfo = {
            type: mediaType,
            url: mediaMessage.url,
            directPath: mediaMessage.directPath,
            mediaKey: mediaMessage.mediaKey,
            mimetype: mediaMessage.mimetype,
            fileLength: mediaMessage.fileLength,
            fileSha256: mediaMessage.fileSha256,
            fileEncSha256: mediaMessage.fileEncSha256,
            
            // Type-specific properties
            width: mediaMessage.width,
            height: mediaMessage.height,
            duration: mediaMessage.seconds,
            pageCount: mediaMessage.pageCount,
            
            // Download info
            downloadable: !!(mediaMessage.url || mediaMessage.directPath),
            downloaded: false,
            localPath: null,
            buffer: null
        };

        logger.info(`✅ Media info extracted: ${JSON.stringify({
            type: mediaInfo.type,
            mimetype: mediaInfo.mimetype,
            fileLength: mediaInfo.fileLength,
            downloadable: mediaInfo.downloadable,
            hasUrl: !!mediaInfo.url,
            hasDirectPath: !!mediaInfo.directPath
        }, null, 2)}`);

        return mediaInfo;
    }

    /**
     * Queue message for synchronization
     */
    async queueMessageForSync(messageInfo) {
        const queueId = `${messageInfo.id}_${Date.now()}`;
        
        logger.info(`📥 QUEUING message for sync: ${queueId}`);
        
        this.messageQueue.set(queueId, {
            ...messageInfo,
            queueId,
            queuedAt: Date.now(),
            attempts: 0,
            maxAttempts: 3
        });
        
        this.syncStats.totalMessages++;
        
        logger.info(`📊 Queue status: ${this.messageQueue.size} messages pending`);
    }

    /**
     * Process message queue
     */
    async processMessageQueue() {
        if (this.processingQueue) {
            logger.info('⏳ Queue already being processed, skipping...');
            return;
        }

        if (this.messageQueue.size === 0) {
            logger.info('📭 No messages in queue to process');
            return;
        }

        this.processingQueue = true;
        logger.info(`🔄 PROCESSING message queue: ${this.messageQueue.size} messages`);

        try {
            const messages = Array.from(this.messageQueue.values());
            
            for (const messageInfo of messages) {
                await this.processSingleMessage(messageInfo);
            }
            
        } catch (error) {
            logger.error('❌ Error processing message queue:', error);
        } finally {
            this.processingQueue = false;
            logger.info('✅ Queue processing completed');
        }
    }

    /**
     * Process a single message
     */
    async processSingleMessage(messageInfo) {
        try {
            logger.info(`🔄 PROCESSING message: ${messageInfo.id} (attempt ${messageInfo.attempts + 1})`);
            
            messageInfo.attempts++;
            
            // Skip if from self and not enabled
            if (messageInfo.fromMe && !config.get('sync.includeSelfMessages', false)) {
                logger.info('⏭️ Skipping self message (not enabled)');
                this.removeFromQueue(messageInfo.queueId);
                return;
            }
            
            // Skip if from ignored chat
            if (this.isIgnoredChat(messageInfo.remoteJid)) {
                logger.info('⏭️ Skipping ignored chat');
                this.removeFromQueue(messageInfo.queueId);
                return;
            }
            
            // Download media if needed
            if (messageInfo.mediaInfo && !messageInfo.mediaInfo.downloaded) {
                await this.downloadMedia(messageInfo);
            }
            
            // Sync to Telegram
            if (this.telegramBridge) {
                const success = await this.telegramBridge.syncWhatsAppMessage(messageInfo);
                
                if (success) {
                    messageInfo.syncedToTelegram = true;
                    messageInfo.processed = true;
                    this.syncStats.processedMessages++;
                    logger.info(`✅ Successfully synced message: ${messageInfo.id}`);
                    this.removeFromQueue(messageInfo.queueId);
                } else {
                    throw new Error('Failed to sync to Telegram');
                }
            } else {
                logger.warn('⚠️ Telegram bridge not available');
                this.removeFromQueue(messageInfo.queueId);
            }
            
        } catch (error) {
            logger.error(`❌ Error processing message ${messageInfo.id}:`, error);
            
            if (messageInfo.attempts >= messageInfo.maxAttempts) {
                logger.error(`💀 Max attempts reached for message ${messageInfo.id}, removing from queue`);
                this.syncStats.failedMessages++;
                this.removeFromQueue(messageInfo.queueId);
            } else {
                logger.info(`🔄 Will retry message ${messageInfo.id} (attempt ${messageInfo.attempts}/${messageInfo.maxAttempts})`);
            }
        }
    }

    /**
     * Download media for message
     */
    async downloadMedia(messageInfo) {
        if (!messageInfo.mediaInfo) {
            logger.warn('⚠️ No media info to download');
            return false;
        }

        try {
            logger.info(`📥 DOWNLOADING media for message: ${messageInfo.id}`);
            logger.info(`📊 Media type: ${messageInfo.mediaInfo.type}, Size: ${messageInfo.mediaInfo.fileLength} bytes`);
            
            // Get the media message object
            const mediaMessage = this.getMediaMessageObject(messageInfo);
            if (!mediaMessage) {
                throw new Error('Could not get media message object');
            }
            
            // Download using WhatsApp client
            const buffer = await this.whatsappBot.sock.downloadMediaMessage(
                { message: { [messageInfo.messageType + 'Message']: mediaMessage } },
                messageInfo.mediaInfo.type,
                {}
            );
            
            if (!buffer || buffer.length === 0) {
                throw new Error('Downloaded buffer is empty');
            }
            
            messageInfo.mediaInfo.buffer = buffer;
            messageInfo.mediaInfo.downloaded = true;
            
            logger.info(`✅ Media downloaded successfully: ${buffer.length} bytes`);
            return true;
            
        } catch (error) {
            logger.error(`❌ Error downloading media for ${messageInfo.id}:`, error);
            messageInfo.error = error.message;
            return false;
        }
    }

    /**
     * Get media message object for download
     */
    getMediaMessageObject(messageInfo) {
        // This would need to be implemented based on how you store the original message
        // For now, return the mediaInfo as it should contain the necessary properties
        return messageInfo.mediaInfo;
    }

    /**
     * Check if chat should be ignored
     */
    isIgnoredChat(remoteJid) {
        const ignoredChats = config.get('sync.ignoredChats', []);
        return ignoredChats.includes(remoteJid);
    }

    /**
     * Remove message from queue
     */
    removeFromQueue(queueId) {
        this.messageQueue.delete(queueId);
        logger.info(`🗑️ Removed message from queue: ${queueId}`);
    }

    /**
     * Get sync statistics
     */
    getSyncStats() {
        return {
            ...this.syncStats,
            queueSize: this.messageQueue.size,
            successRate: this.syncStats.totalMessages > 0 
                ? (this.syncStats.processedMessages / this.syncStats.totalMessages * 100).toFixed(2) + '%'
                : '0%'
        };
    }

    /**
     * Clear queue and reset stats
     */
    reset() {
        this.messageQueue.clear();
        this.syncStats = {
            totalMessages: 0,
            processedMessages: 0,
            failedMessages: 0,
            mediaMessages: 0,
            textMessages: 0
        };
        logger.info('🔄 Message sync detector reset');
    }
}

module.exports = WhatsAppMessageSyncDetector;
