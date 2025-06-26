const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.userProfiles = new Map(); // Track user profile pictures
        this.messageQueue = [];
        this.isProcessing = false;
        this.tempDir = path.join(__dirname, '../temp');
        
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle incoming Telegram messages
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle callback queries
        this.telegramBot.on('callback_query', async (query) => {
            await this.handleCallback(query);
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('2345678901')) {
            logger.debug('Telegram log channel not configured');
            return;
        }

        try {
            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        // Skip status updates and calls
        if (sender.includes('status@broadcast') || whatsappMsg.messageStubType) {
            await this.handleSpecialMessages(whatsappMsg);
            return;
        }
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        // Handle different message types
        if (whatsappMsg.message?.imageMessage || 
            whatsappMsg.message?.videoMessage || 
            whatsappMsg.message?.audioMessage || 
            whatsappMsg.message?.documentMessage ||
            whatsappMsg.message?.stickerMessage) {
            await this.handleWhatsAppMediaMessage(whatsappMsg, topicId);
        } else if (text) {
            await this.sendTextToTelegram(topicId, text);
        }
    }

    async handleSpecialMessages(whatsappMsg) {
        const sender = whatsappMsg.key.remoteJid;
        
        // Handle status updates
        if (sender.includes('status@broadcast')) {
            const topicId = await this.getOrCreateStatusTopic();
            await this.handleStatusUpdate(whatsappMsg, topicId);
            return;
        }
        
        // Handle calls
        if (whatsappMsg.messageStubType === 1 || whatsappMsg.messageStubType === 2) {
            const topicId = await this.getOrCreateCallTopic();
            await this.handleCallUpdate(whatsappMsg, topicId);
            return;
        }
    }

    async getOrCreateStatusTopic() {
        const statusKey = 'status@broadcast';
        if (this.chatMappings.has(statusKey)) {
            return this.chatMappings.get(statusKey);
        }

        const chatId = config.get('telegram.chatId');
        try {
            const topic = await this.telegramBot.createForumTopic(chatId, '📱 WhatsApp Status', {
                icon_color: 0x00D4AA
            });
            this.chatMappings.set(statusKey, topic.message_thread_id);
            return topic.message_thread_id;
        } catch (error) {
            logger.error('Failed to create status topic:', error);
            return null;
        }
    }

    async getOrCreateCallTopic() {
        const callKey = 'calls@system';
        if (this.chatMappings.has(callKey)) {
            return this.chatMappings.get(callKey);
        }

        const chatId = config.get('telegram.chatId');
        try {
            const topic = await this.telegramBot.createForumTopic(chatId, '📞 WhatsApp Calls', {
                icon_color: 0xFF6B6B
            });
            this.chatMappings.set(callKey, topic.message_thread_id);
            return topic.message_thread_id;
        } catch (error) {
            logger.error('Failed to create call topic:', error);
            return null;
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        // Extract user info from WhatsApp
        let userName = 'Unknown User';
        let userPhone = participant.split('@')[0];
        
        try {
            // Try to get contact name
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0]) {
                    userName = contact[0].notify || userPhone;
                }
            }
        } catch (error) {
            logger.debug('Could not fetch contact info:', error);
        }

        this.userMappings.set(participant, {
            name: userName,
            phone: userPhone,
            firstSeen: new Date(),
            messageCount: 0
        });

        logger.debug(`👤 Created user mapping: ${userName} (${userPhone})`);
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId || chatId.includes('2345678901')) {
            logger.error('❌ Telegram chat ID not configured properly');
            return null;
        }

        try {
            // Create topic name
            const isGroup = chatJid.endsWith('@g.us');
            let topicName;
            
            if (isGroup) {
                // For groups, try to get group name
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `📱 ${groupMeta.subject}`;
                } catch (error) {
                    topicName = `📱 Group Chat`;
                }
            } else {
                // For individual chats
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                topicName = `👤 ${userInfo ? userInfo.name : 'Private Chat'}`;
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send profile picture if available
            await this.sendProfilePicture(topic.message_thread_id, chatJid, isGroup);
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendProfilePicture(topicId, chatJid, isGroup) {
        const chatId = config.get('telegram.chatId');
        
        try {
            let profilePicUrl = null;
            
            if (isGroup) {
                profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(chatJid, 'image');
            } else {
                const participant = chatJid.replace('@s.whatsapp.net', '@c.us');
                profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(participant, 'image');
            }
            
            if (profilePicUrl) {
                await this.telegramBot.sendPhoto(chatId, profilePicUrl, {
                    message_thread_id: topicId,
                    caption: '📸 Profile Picture'
                });
                
                // Store current profile picture
                this.userProfiles.set(chatJid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not fetch profile picture:', error);
        }
    }

    async handleWhatsAppMediaMessage(whatsappMsg, topicId) {
        if (!topicId) return;

        const chatId = config.get('telegram.chatId');
        
        try {
            const message = whatsappMsg.message;
            let mediaBuffer = null;
            let fileName = null;
            let mimeType = null;

            // Download media based on type
            if (message.imageMessage) {
                mediaBuffer = await downloadMediaMessage(whatsappMsg, 'buffer', {});
                fileName = `image_${Date.now()}.jpg`;
                mimeType = message.imageMessage.mimetype || 'image/jpeg';
            } else if (message.videoMessage) {
                mediaBuffer = await downloadMediaMessage(whatsappMsg, 'buffer', {});
                fileName = `video_${Date.now()}.mp4`;
                mimeType = message.videoMessage.mimetype || 'video/mp4';
            } else if (message.audioMessage) {
                mediaBuffer = await downloadMediaMessage(whatsappMsg, 'buffer', {});
                fileName = `audio_${Date.now()}.ogg`;
                mimeType = message.audioMessage.mimetype || 'audio/ogg';
            } else if (message.documentMessage) {
                mediaBuffer = await downloadMediaMessage(whatsappMsg, 'buffer', {});
                fileName = message.documentMessage.fileName || `document_${Date.now()}`;
                mimeType = message.documentMessage.mimetype || 'application/octet-stream';
            } else if (message.stickerMessage) {
                mediaBuffer = await downloadMediaMessage(whatsappMsg, 'buffer', {});
                fileName = `sticker_${Date.now()}.webp`;
                mimeType = message.stickerMessage.mimetype || 'image/webp';
            }

            if (mediaBuffer) {
                // Save to temp file
                const tempFilePath = path.join(this.tempDir, fileName);
                fs.writeFileSync(tempFilePath, mediaBuffer);

                // Send based on media type
                if (message.imageMessage) {
                    await this.telegramBot.sendPhoto(chatId, tempFilePath, {
                        message_thread_id: topicId
                    });
                } else if (message.videoMessage) {
                    await this.telegramBot.sendVideo(chatId, tempFilePath, {
                        message_thread_id: topicId
                    });
                } else if (message.audioMessage) {
                    if (message.audioMessage.ptt) {
                        // Voice message
                        await this.telegramBot.sendVoice(chatId, tempFilePath, {
                            message_thread_id: topicId
                        });
                    } else {
                        // Regular audio
                        await this.telegramBot.sendAudio(chatId, tempFilePath, {
                            message_thread_id: topicId
                        });
                    }
                } else if (message.documentMessage) {
                    await this.telegramBot.sendDocument(chatId, tempFilePath, {
                        message_thread_id: topicId
                    });
                } else if (message.stickerMessage) {
                    await this.telegramBot.sendSticker(chatId, tempFilePath, {
                        message_thread_id: topicId
                    });
                }

                // Clean up temp file
                fs.unlinkSync(tempFilePath);
            }

        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp media:', error);
        }
    }

    async sendTextToTelegram(topicId, text) {
        if (!topicId) return;

        const chatId = config.get('telegram.chatId');
        
        try {
            await this.telegramBot.sendMessage(chatId, text, {
                message_thread_id: topicId
            });
        } catch (error) {
            logger.error('❌ Failed to send text to Telegram:', error);
        }
    }

    async handleTelegramMessage(msg) {
        // Handle messages from Telegram back to WhatsApp
        try {
            // Find the corresponding WhatsApp chat
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid || whatsappJid.includes('@broadcast') || whatsappJid.includes('@system')) {
                return; // Skip special topics
            }

            // Handle different message types from Telegram
            if (msg.text) {
                await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            } else if (msg.photo) {
                await this.handleTelegramPhoto(msg, whatsappJid);
            } else if (msg.video) {
                await this.handleTelegramVideo(msg, whatsappJid);
            } else if (msg.voice) {
                await this.handleTelegramVoice(msg, whatsappJid);
            } else if (msg.video_note) {
                await this.handleTelegramVideoNote(msg, whatsappJid);
            } else if (msg.audio) {
                await this.handleTelegramAudio(msg, whatsappJid);
            } else if (msg.document) {
                await this.handleTelegramDocument(msg, whatsappJid);
            } else if (msg.sticker) {
                await this.handleTelegramSticker(msg, whatsappJid);
            }
            
            // React with checkmark as confirmation
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, '✅');

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            // React with error emoji
            try {
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, '❌');
            } catch (reactionError) {
                logger.debug('Could not set error reaction:', reactionError);
            }
        }
    }

    async handleTelegramPhoto(msg, whatsappJid) {
        const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
        const fileLink = await this.telegramBot.getFileLink(photo.file_id);
        const fileName = `photo_${Date.now()}.jpg`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'image');
    }

    async handleTelegramVideo(msg, whatsappJid) {
        const fileLink = await this.telegramBot.getFileLink(msg.video.file_id);
        const fileName = `video_${Date.now()}.mp4`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'video');
    }

    async handleTelegramVoice(msg, whatsappJid) {
        const fileLink = await this.telegramBot.getFileLink(msg.voice.file_id);
        const fileName = `voice_${Date.now()}.ogg`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'audio', true);
    }

    async handleTelegramVideoNote(msg, whatsappJid) {
        const fileLink = await this.telegramBot.getFileLink(msg.video_note.file_id);
        const fileName = `video_note_${Date.now()}.mp4`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'video');
    }

    async handleTelegramAudio(msg, whatsappJid) {
        const fileLink = await this.telegramBot.getFileLink(msg.audio.file_id);
        const fileName = `audio_${Date.now()}.mp3`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'audio');
    }

    async handleTelegramDocument(msg, whatsappJid) {
        const fileLink = await this.telegramBot.getFileLink(msg.document.file_id);
        const fileName = msg.document.file_name || `document_${Date.now()}`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'document');
    }

    async handleTelegramSticker(msg, whatsappJid) {
        const fileLink = await this.telegramBot.getFileLink(msg.sticker.file_id);
        const fileName = `sticker_${Date.now()}.webp`;
        await this.downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, 'sticker');
    }

    async downloadAndSendToWhatsApp(fileLink, fileName, whatsappJid, mediaType, isPtt = false) {
        try {
            const response = await fetch(fileLink);
            const buffer = await response.buffer();
            
            const tempFilePath = path.join(this.tempDir, fileName);
            fs.writeFileSync(tempFilePath, buffer);

            let messageOptions = {};

            switch (mediaType) {
                case 'image':
                    messageOptions = {
                        image: { url: tempFilePath }
                    };
                    break;
                case 'video':
                    messageOptions = {
                        video: { url: tempFilePath }
                    };
                    break;
                case 'audio':
                    messageOptions = {
                        audio: { url: tempFilePath },
                        ptt: isPtt
                    };
                    break;
                case 'document':
                    messageOptions = {
                        document: { url: tempFilePath },
                        fileName: fileName
                    };
                    break;
                case 'sticker':
                    messageOptions = {
                        sticker: { url: tempFilePath }
                    };
                    break;
            }

            await this.whatsappBot.sendMessage(whatsappJid, messageOptions);
            
            // Clean up temp file
            fs.unlinkSync(tempFilePath);

        } catch (error) {
            logger.error(`Failed to download and send ${mediaType}:`, error);
        }
    }

    async handleCallback(query) {
        const [action, data] = query.data.split('_');
        
        try {
            switch (action) {
                case 'reply':
                    await this.handleReplyCallback(query, data);
                    break;
                case 'info':
                    await this.handleInfoCallback(query, data);
                    break;
            }
        } catch (error) {
            logger.error('❌ Failed to handle callback:', error);
        }
    }

    async handleReplyCallback(query, messageId) {
        await this.telegramBot.answerCallbackQuery(query.id, {
            text: '💬 Reply to the message to send back to WhatsApp',
            show_alert: false
        });
    }

    async handleInfoCallback(query, participantId) {
        const userInfo = this.userMappings.get(participantId);
        
        if (userInfo) {
            const infoText = `👤 User: ${userInfo.name}\n📱 Phone: ${userInfo.phone}\n👋 First Seen: ${userInfo.firstSeen.toLocaleString()}\n💬 Messages: ${userInfo.messageCount}`;
            
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: infoText,
                show_alert: true
            });
        } else {
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: '❌ User information not found',
                show_alert: true
            });
        }
    }

    async handleProfilePictureUpdate(whatsappMsg) {
        const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
        const topicId = await this.getOrCreateTopic(whatsappMsg.key.remoteJid, whatsappMsg);
        
        if (topicId) {
            const chatId = config.get('telegram.chatId');
            
            try {
                const newProfilePicUrl = await this.whatsappBot.sock.profilePictureUrl(participant, 'image');
                const oldProfilePicUrl = this.userProfiles.get(participant);
                
                if (newProfilePicUrl && newProfilePicUrl !== oldProfilePicUrl) {
                    await this.telegramBot.sendPhoto(chatId, newProfilePicUrl, {
                        message_thread_id: topicId,
                        caption: '📸 Profile Picture Updated'
                    });
                    
                    this.userProfiles.set(participant, newProfilePicUrl);
                }
            } catch (error) {
                logger.debug('Could not handle profile picture update:', error);
            }
        }
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
            logger.info('📱 Telegram bridge stopped');
        }
        
        // Clean up temp directory
        try {
            const files = fs.readdirSync(this.tempDir);
            for (const file of files) {
                fs.unlinkSync(path.join(this.tempDir, file));
            }
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
    }
}

module.exports = TelegramBridge;
