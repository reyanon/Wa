const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.messagePairs = new Map(); // Telegram Message ID -> WhatsApp Message Data
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map(); // Track active calls to prevent spam
        this.statusMessageIds = new Map(); // Track status message IDs for replies
        this.profilePicUpdateQueue = new Map(); // Queue for profile picture updates
        
        // Enhanced configuration
        this.config = {
            enabled: config.get('telegram.enabled', false),
            botToken: config.get('telegram.botToken'),
            chatId: config.get('telegram.chatId'),
            logChannel: config.get('telegram.logChannel'),
            ownerIds: config.get('telegram.ownerIds', []),
            sudoUsers: config.get('telegram.sudoUsers', []),
            
            // Media settings
            skipVideoStickers: config.get('telegram.skipVideoStickers', false),
            skipDocuments: config.get('telegram.skipDocuments', false),
            skipImages: config.get('telegram.skipImages', false),
            skipVideos: config.get('telegram.skipVideos', false),
            skipAudios: config.get('telegram.skipAudios', false),
            skipStickers: config.get('telegram.skipStickers', false),
            skipContacts: config.get('telegram.skipContacts', false),
            skipLocations: config.get('telegram.skipLocations', false),
            skipStatus: config.get('telegram.skipStatus', false),
            
            // Message confirmation settings
            confirmationType: config.get('telegram.confirmationType', 'emoji'), // emoji, text, none
            silentConfirmation: config.get('telegram.silentConfirmation', false),
            
            // Advanced features
            spoilerViewOnce: config.get('telegram.spoilerViewOnce', true),
            reactions: config.get('telegram.reactions', true),
            sendPresence: config.get('telegram.sendPresence', true),
            sendReadReceipts: config.get('telegram.sendReadReceipts', true),
            sendMyPresence: config.get('telegram.sendMyPresence', true),
            sendMyReadReceipts: config.get('telegram.sendMyReadReceipts', true),
            
            // Profile picture settings
            syncProfilePictures: config.get('telegram.syncProfilePictures', true),
            profilePicUpdateInterval: config.get('telegram.profilePicUpdateInterval', 3600000), // 1 hour
            
            // Audio processing
            generateWaveforms: config.get('telegram.generateWaveforms', true),
            audioQuality: config.get('telegram.audioQuality', 'medium'), // low, medium, high
            
            // Video processing
            videoQuality: config.get('telegram.videoQuality', 'medium'),
            maxVideoSize: config.get('telegram.maxVideoSize', 50 * 1024 * 1024), // 50MB
            
            // Sticker processing
            stickerFallbackToPng: config.get('telegram.stickerFallbackToPng', true),
            animatedStickerToGif: config.get('telegram.animatedStickerToGif', true)
        };
    }

    async initialize() {
        const token = this.config.botToken;
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            // Ensure temp directory exists
            await fs.ensureDir(this.tempDir);
            
            this.telegramBot = new TelegramBot(token, { 
                polling: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    }
                }
            });
            
            await this.setupTelegramHandlers();
            await this.startProfilePicSync();
            logger.info('✅ Enhanced Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle all types of messages
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle specific media types with enhanced processing
        this.telegramBot.on('photo', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'photo');
            }
        });

        this.telegramBot.on('video', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'video');
            }
        });

        this.telegramBot.on('animation', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'animation');
            }
        });

        this.telegramBot.on('video_note', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'video_note');
            }
        });

        this.telegramBot.on('voice', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'voice');
            }
        });

        this.telegramBot.on('audio', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'audio');
            }
        });

        this.telegramBot.on('document', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'document');
            }
        });

        this.telegramBot.on('sticker', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'sticker');
            }
        });

        this.telegramBot.on('location', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramLocation(msg);
            }
        });

        this.telegramBot.on('contact', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramContact(msg);
            }
        });

        // Handle callback queries for message actions
        this.telegramBot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
        });

        logger.info('📱 Enhanced Telegram message handlers set up');
    }

    async startProfilePicSync() {
        if (!this.config.syncProfilePictures) return;
        
        // Start periodic profile picture sync
        setInterval(async () => {
            await this.syncAllProfilePictures();
        }, this.config.profilePicUpdateInterval);
        
        logger.info('📸 Profile picture sync started');
    }

    async syncAllProfilePictures() {
        try {
            for (const [jid, userInfo] of this.userMappings.entries()) {
                try {
                    const currentPicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
                    const cachedPicUrl = this.profilePicCache.get(jid);
                    
                    if (currentPicUrl && currentPicUrl !== cachedPicUrl) {
                        // Profile picture changed
                        this.profilePicCache.set(jid, currentPicUrl);
                        
                        const topicId = this.chatMappings.get(jid);
                        if (topicId) {
                            await this.sendProfilePictureUpdate(topicId, jid, currentPicUrl);
                        }
                    }
                } catch (error) {
                    // Ignore individual profile pic errors
                }
                
                // Rate limiting
                await this.sleep(1000);
            }
        } catch (error) {
            logger.debug('Error in profile picture sync:', error);
        }
    }

    async sendProfilePictureUpdate(topicId, jid, profilePicUrl) {
        try {
            const userInfo = this.userMappings.get(jid);
            const name = userInfo?.name || jid.split('@')[0];
            
            await this.telegramBot.sendPhoto(this.config.chatId, profilePicUrl, {
                message_thread_id: topicId,
                caption: `📸 **${name}** updated their profile picture`,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send profile picture update:', error);
        }
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = this.config.logChannel;
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
        if (!this.telegramBot || !this.config.enabled) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        // Handle different message types with enhanced processing
        let sentMessageId = null;
        
        if (whatsappMsg.message?.imageMessage && !this.config.skipImages) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage && !this.config.skipVideos) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage && !this.config.skipAudios) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage && !this.config.skipDocuments) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage && !this.config.skipStickers) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage && !this.config.skipLocations) { 
            sentMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if ((whatsappMsg.message?.contactMessage || whatsappMsg.message?.contactsArrayMessage) && !this.config.skipContacts) { 
            sentMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.viewOnceMessage || whatsappMsg.message?.viewOnceMessageV2) {
            sentMessageId = await this.handleWhatsAppViewOnce(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.ephemeralMessage) {
            sentMessageId = await this.handleWhatsAppEphemeral(whatsappMsg, topicId);
        } else if (text) {
            // Send text message
            sentMessageId = await this.sendSimpleMessage(topicId, text, sender, participant, whatsappMsg);
        }
        
        // Store message pair for revoke functionality
        if (sentMessageId && whatsappMsg.key.id) {
            this.messagePairs.set(sentMessageId, {
                whatsappId: whatsappMsg.key.id,
                whatsappJid: sender,
                telegramMessageId: sentMessageId,
                timestamp: new Date()
            });
        }
        
        // Store status message ID for reply handling
        if (sender === 'status@broadcast' && sentMessageId) {
            this.statusMessageIds.set(sentMessageId, whatsappMsg.key);
        }
    }

    async handleWhatsAppViewOnce(whatsappMsg, topicId) {
        try {
            const viewOnceMsg = whatsappMsg.message.viewOnceMessage || whatsappMsg.message.viewOnceMessageV2;
            const innerMessage = viewOnceMsg.message;
            
            let mediaType = null;
            let mediaMessage = null;
            
            if (innerMessage.imageMessage) {
                mediaType = 'image';
                mediaMessage = innerMessage.imageMessage;
            } else if (innerMessage.videoMessage) {
                mediaType = 'video';
                mediaMessage = innerMessage.videoMessage;
            }
            
            if (mediaType && mediaMessage) {
                // Download and process media
                const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                const buffer = await this.streamToBuffer(stream);
                
                const fileName = `viewonce_${Date.now()}.${mediaType === 'image' ? 'jpg' : 'mp4'}`;
                const filePath = path.join(this.tempDir, fileName);
                await fs.writeFile(filePath, buffer);
                
                const sender = whatsappMsg.key.remoteJid;
                const participant = whatsappMsg.key.participant || sender;
                let caption = this.extractText(whatsappMsg) || '';
                
                // Add sender info for group messages
                if (sender.endsWith('@g.us') && participant !== sender) {
                    const userInfo = this.userMappings.get(participant);
                    const name = userInfo?.name || participant.split('@')[0];
                    caption = `👤 **${name}**: ${caption}`;
                }
                
                // Add view once indicator with spoiler if enabled
                if (this.config.spoilerViewOnce) {
                    caption = `🔒 **View Once ${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}**\n\n||${caption}||`;
                } else {
                    caption = `🔒 **View Once ${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}**\n\n${caption}`;
                }
                
                const options = {
                    message_thread_id: topicId,
                    caption: caption,
                    parse_mode: 'Markdown',
                    has_spoiler: this.config.spoilerViewOnce
                };
                
                let sentMessage;
                if (mediaType === 'image') {
                    sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, filePath, options);
                } else {
                    sentMessage = await this.telegramBot.sendVideo(this.config.chatId, filePath, options);
                }
                
                // Clean up temp file
                await fs.unlink(filePath).catch(() => {});
                
                return sentMessage.message_id;
            }
            
            return null;
        } catch (error) {
            logger.error('❌ Failed to handle view once message:', error);
            return null;
        }
    }

    async handleWhatsAppEphemeral(whatsappMsg, topicId) {
        try {
            const ephemeralMsg = whatsappMsg.message.ephemeralMessage;
            const innerMessage = ephemeralMsg.message;
            
            // Extract text from ephemeral message
            const text = innerMessage.conversation || 
                        innerMessage.extendedTextMessage?.text || 
                        '';
            
            if (text) {
                const sender = whatsappMsg.key.remoteJid;
                const participant = whatsappMsg.key.participant || sender;
                let messageText = text;
                
                // Add sender info for group messages
                if (sender.endsWith('@g.us') && participant !== sender) {
                    const userInfo = this.userMappings.get(participant);
                    const name = userInfo?.name || participant.split('@')[0];
                    messageText = `👤 **${name}**: ${text}`;
                }
                
                // Add ephemeral indicator
                messageText = `⏰ **Ephemeral Message**\n\n${messageText}`;
                
                const sentMessage = await this.telegramBot.sendMessage(this.config.chatId, messageText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
                
                return sentMessage.message_id;
            }
            
            return null;
        } catch (error) {
            logger.error('❌ Failed to handle ephemeral message:', error);
            return null;
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) {
            // Update existing mapping
            const existing = this.userMappings.get(participant);
            existing.messageCount = (existing.messageCount || 0) + 1;
            existing.lastSeen = new Date();
            
            // Update name if we have a better one
            if (whatsappMsg.pushName && !existing.name) {
                existing.name = whatsappMsg.pushName;
            }
            return;
        }

        // Extract user info from WhatsApp
        let userName = null;
        let userPhone = participant.split('@')[0];
        
        try {
            // Try to get contact name from WhatsApp
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0] && contact[0].notify) {
                    userName = contact[0].notify;
                }
                
                // Try to get pushname from message
                if (whatsappMsg.pushName) {
                    userName = whatsappMsg.pushName;
                }
            }
        } catch (error) {
            logger.debug('Could not fetch contact info:', error);
        }

        this.userMappings.set(participant, {
            name: userName,
            phone: userPhone,
            firstSeen: new Date(),
            lastSeen: new Date(),
            messageCount: 1
        });

        // Queue profile picture sync
        if (this.config.syncProfilePictures) {
            this.queueProfilePictureSync(participant);
        }

        logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`);
    }

    async queueProfilePictureSync(jid) {
        try {
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            if (profilePicUrl) {
                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not sync profile picture:', error);
        }
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        const chatId = this.config.chatId;
        if (!chatId || chatId.includes('2345678901')) {
            logger.error('❌ Telegram chat ID not configured properly');
            return null;
        }

        try {
            const isGroup = chatJid.endsWith('@g.us');
            const isStatus = chatJid === 'status@broadcast';
            const isCall = chatJid === 'call@broadcast';
            
            let topicName;
            let iconColor = 0x7ABA3C; // Default green
            
            if (isStatus) {
                topicName = `📊 Status Updates`;
                iconColor = 0xFF6B35; // Orange
            } else if (isCall) {
                topicName = `📞 Call Logs`;
                iconColor = 0xFF4757; // Red
            } else if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `${groupMeta.subject}`;
                } catch (error) {
                    topicName = `Group Chat`;
                }
                iconColor = 0x6FB9F0; // Blue
            } else {
                // For individual chats - use name OR number, not both
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                const phone = participant.split('@')[0];
                
                if (userInfo && userInfo.name) {
                    topicName = userInfo.name;
                } else {
                    topicName = phone;
                }
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message and pin it
            if (!isStatus && !isCall) {
                await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup);
            }
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, jid, isGroup) {
        try {
            const chatId = this.config.chatId;
            let welcomeText = '';
            
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(jid);
                    welcomeText = `🏷️ **Group Information**\n\n` +
                                 `📝 **Name:** ${groupMeta.subject}\n` +
                                 `👥 **Participants:** ${groupMeta.participants.length}\n` +
                                 `🆔 **Group ID:** \`${jid}\`\n` +
                                 `📅 **Created:** ${new Date(groupMeta.creation * 1000).toLocaleDateString()}\n\n` +
                                 `💬 Messages from this group will appear here`;
                } catch (error) {
                    welcomeText = `🏷️ **Group Chat**\n\n💬 Messages from this group will appear here`;
                }
            } else {
                const userInfo = this.userMappings.get(jid);
                const phone = jid.split('@')[0];
                
                welcomeText = `👤 **Contact Information**\n\n` +
                             `📝 **Name:** ${userInfo?.name || 'Not available'}\n` +
                             `📱 **Phone:** +${phone}\n` +
                             `🆔 **WhatsApp ID:** \`${jid}\`\n` +
                             `📅 **First Contact:** ${new Date().toLocaleDateString()}\n\n` +
                             `💬 Messages with this contact will appear here`;
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            // Pin the welcome message
            await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);

            // Send profile picture if available
            await this.sendProfilePicture(topicId, jid, false);

        } catch (error) {
            logger.error('❌ Failed to send welcome message:', error);
        }
    }

    async sendProfilePicture(topicId, jid, isUpdate = false) {
        try {
            if (!this.config.syncProfilePictures) return;
            
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            
            if (profilePicUrl) {
                const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
                
                await this.telegramBot.sendPhoto(this.config.chatId, profilePicUrl, {
                    message_thread_id: topicId,
                    caption: caption
                });
                
                // Cache the profile pic URL
                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error);
        }
    }

    async handleCallNotification(callEvent) {
        if (!this.telegramBot || !this.config.enabled) return;

        const callerId = callEvent.from;
        const callKey = `${callerId}_${callEvent.id}`;
        if (this.activeCallNotifications.has(callKey)) return;
        this.activeCallNotifications.set(callKey, true);
        setTimeout(() => {
            this.activeCallNotifications.delete(callKey);
        }, 30000);

        try {
            const userInfo = this.userMappings.get(callerId);
            const callerName = userInfo?.name;
            const nameOrNumber = callerName || callerId.split('@')[0];
            const callTime = new Date().toLocaleTimeString();

            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast', participant: callerId }
            });

            const summary = `🔴 ${nameOrNumber}
${callTime} — Incoming Call`;

            await this.telegramBot.sendMessage(this.config.chatId, summary, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            let caption = this.extractText(whatsappMsg);
            
            switch (mediaType) {
                case 'image':
                    mediaMessage = whatsappMsg.message.imageMessage;
                    fileName += '.jpg';
                    break;
                case 'video':
                    mediaMessage = whatsappMsg.message.videoMessage;
                    fileName += '.mp4';
                    break;
                case 'audio':
                    mediaMessage = whatsappMsg.message.audioMessage;
                    fileName += '.ogg';
                    break;
                case 'document':
                    mediaMessage = whatsappMsg.message.documentMessage;
                    fileName = mediaMessage.fileName || `document_${Date.now()}`;
                    break;
                case 'sticker':
                    mediaMessage = whatsappMsg.message.stickerMessage;
                    fileName += '.webp';
                    break;
            }

            // Add sender info for group messages
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            if (sender.endsWith('@g.us') && participant !== sender) {
                const userInfo = this.userMappings.get(participant);
                const name = userInfo?.name || participant.split('@')[0];
                caption = `👤 **${name}**: ${caption}`;
            }

            // Handle view once media
            if (mediaMessage.viewOnce && this.config.spoilerViewOnce) {
                caption = `🔒 **View Once Media**\n\n||${caption}||`;
            }

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to Telegram based on media type with enhanced processing
            let sentMessage;
            const options = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown',
                has_spoiler: mediaMessage.viewOnce && this.config.spoilerViewOnce
            };

            switch (mediaType) {
                case 'image':
                    // Process image if needed
                    const processedImagePath = await this.processImage(filePath);
                    sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, processedImagePath, options);
                    if (processedImagePath !== filePath) {
                        await fs.unlink(processedImagePath).catch(() => {});
                    }
                    break;
                    
                case 'video':
                    // Process video if needed
                    const processedVideoPath = await this.processVideo(filePath, mediaMessage);
                    if (mediaMessage.gifPlayback) {
                        sentMessage = await this.telegramBot.sendAnimation(this.config.chatId, processedVideoPath, options);
                    } else {
                        sentMessage = await this.telegramBot.sendVideo(this.config.chatId, processedVideoPath, options);
                    }
                    if (processedVideoPath !== filePath) {
                        await fs.unlink(processedVideoPath).catch(() => {});
                    }
                    break;
                    
                case 'audio':
                    // Process audio with enhanced features
                    const processedAudioPath = await this.processAudio(filePath, mediaMessage);
                    if (mediaMessage.ptt) {
                        // Generate waveform for voice messages
                        const waveform = this.config.generateWaveforms ? 
                            await this.generateWaveform(processedAudioPath) : null;
                        
                        const voiceOptions = {
                            message_thread_id: topicId,
                            caption: caption,
                            parse_mode: 'Markdown'
                        };
                        
                        if (waveform) {
                            voiceOptions.waveform = waveform;
                        }
                        
                        sentMessage = await this.telegramBot.sendVoice(this.config.chatId, processedAudioPath, voiceOptions);
                    } else {
                        sentMessage = await this.telegramBot.sendAudio(this.config.chatId, processedAudioPath, options);
                    }
                    if (processedAudioPath !== filePath) {
                        await fs.unlink(processedAudioPath).catch(() => {});
                    }
                    break;
                    
                case 'document':
                    sentMessage = await this.telegramBot.sendDocument(this.config.chatId, filePath, options);
                    break;
                    
                case 'sticker':
                    sentMessage = await this.handleStickerWithFallback(filePath, options);
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            return sentMessage?.message_id;
        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
            return null;
        }
    }

    async processImage(filePath) {
        try {
            const outputPath = filePath.replace(/\.[^/.]+$/, '_processed.jpg');
            
            await sharp(filePath)
                .jpeg({ quality: 85, progressive: true })
                .resize(1920, 1920, { 
                    fit: 'inside', 
                    withoutEnlargement: true 
                })
                .toFile(outputPath);
                
            return outputPath;
        } catch (error) {
            logger.debug('Could not process image:', error);
            return filePath;
        }
    }

    async processVideo(filePath, mediaMessage) {
        try {
            const outputPath = filePath.replace(/\.[^/.]+$/, '_processed.mp4');
            
            return new Promise((resolve, reject) => {
                let ffmpegCommand = ffmpeg(filePath)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .format('mp4')
                    .outputOptions(['-movflags +faststart']);
                
                // Apply quality settings
                switch (this.config.videoQuality) {
                    case 'low':
                        ffmpegCommand = ffmpegCommand
                            .videoBitrate('500k')
                            .size('640x?');
                        break;
                    case 'high':
                        ffmpegCommand = ffmpegCommand
                            .videoBitrate('2000k')
                            .size('1280x?');
                        break;
                    default: // medium
                        ffmpegCommand = ffmpegCommand
                            .videoBitrate('1000k')
                            .size('854x?');
                }
                
                ffmpegCommand
                    .on('end', () => resolve(outputPath))
                    .on('error', (error) => {
                        logger.debug('Video processing failed:', error);
                        resolve(filePath);
                    })
                    .save(outputPath);
            });
        } catch (error) {
            logger.debug('Could not process video:', error);
            return filePath;
        }
    }

    async processAudio(filePath, mediaMessage) {
        try {
            const outputPath = filePath.replace(/\.[^/.]+$/, '_processed.ogg');
            
            return new Promise((resolve, reject) => {
                let ffmpegCommand = ffmpeg(filePath)
                    .audioCodec('libopus')
                    .format('ogg');
                
                if (mediaMessage.ptt) {
                    // Voice message processing
                    ffmpegCommand = ffmpegCommand
                        .audioChannels(1)
                        .audioFrequency(16000)
                        .audioBitrate('24k');
                } else {
                    // Regular audio processing
                    switch (this.config.audioQuality) {
                        case 'low':
                            ffmpegCommand = ffmpegCommand.audioBitrate('64k');
                            break;
                        case 'high':
                            ffmpegCommand = ffmpegCommand.audioBitrate('192k');
                            break;
                        default: // medium
                            ffmpegCommand = ffmpegCommand.audioBitrate('128k');
                    }
                }
                
                ffmpegCommand
                    .on('end', () => resolve(outputPath))
                    .on('error', (error) => {
                        logger.debug('Audio processing failed:', error);
                        resolve(filePath);
                    })
                    .save(outputPath);
            });
        } catch (error) {
            logger.debug('Could not process audio:', error);
            return filePath;
        }
    }

    async generateWaveform(audioPath) {
        try {
            return new Promise((resolve, reject) => {
                ffmpeg.ffprobe(audioPath, (err, metadata) => {
                    if (err) {
                        // Generate fake waveform
                        const duration = 10; // Default duration
                        const samples = Math.min(Math.floor(duration), 60);
                        const waveform = [];
                        
                        for (let i = 0; i < samples; i++) {
                            waveform.push(Math.floor(Math.random() * 100) + 1);
                        }
                        
                        resolve(Buffer.from(waveform));
                        return;
                    }
                    
                    const duration = metadata.format.duration || 10;
                    const samples = Math.min(Math.floor(duration), 60);
                    const waveform = [];
                    
                    // Generate more realistic waveform based on duration
                    for (let i = 0; i < samples; i++) {
                        const progress = i / samples;
                        const amplitude = Math.sin(progress * Math.PI) * 100;
                        waveform.push(Math.floor(amplitude * Math.random()) + 10);
                    }
                    
                    resolve(Buffer.from(waveform));
                });
            });
        } catch (error) {
            // Fallback waveform
            return Buffer.from([50, 75, 25, 100, 60, 80, 40, 90, 30, 70]);
        }
    }

    async handleStickerWithFallback(filePath, options) {
        try {
            // Try to send as sticker first
            return await this.telegramBot.sendSticker(this.config.chatId, filePath, {
                message_thread_id: options.message_thread_id
            });
        } catch (stickerError) {
            logger.debug('Sticker send failed, trying fallback:', stickerError);
            
            if (this.config.stickerFallbackToPng) {
                try {
                    // Convert to PNG and send as photo
                    const pngPath = filePath.replace('.webp', '.png');
                    await sharp(filePath).png().toFile(pngPath);
                    
                    const sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, pngPath, {
                        message_thread_id: options.message_thread_id,
                        caption: options.caption || 'Sticker',
                        parse_mode: 'Markdown'
                    });
                    
                    await fs.unlink(pngPath).catch(() => {});
                    return sentMessage;
                } catch (pngError) {
                    logger.debug('PNG conversion failed:', pngError);
                    
                    // Final fallback: send as document
                    return await this.telegramBot.sendDocument(this.config.chatId, filePath, {
                        message_thread_id: options.message_thread_id,
                        caption: options.caption || 'Sticker (as document)',
                        parse_mode: 'Markdown'
                    });
                }
            } else {
                // Send as document directly
                return await this.telegramBot.sendDocument(this.config.chatId, filePath, {
                    message_thread_id: options.message_thread_id,
                    caption: options.caption || 'Sticker (as document)',
                    parse_mode: 'Markdown'
                });
            }
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const locationMessage = whatsappMsg.message.locationMessage;
            
            // Add sender info for group messages
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            const sentMessage = await this.telegramBot.sendLocation(this.config.chatId, 
                locationMessage.degreesLatitude, 
                locationMessage.degreesLongitude, {
                    message_thread_id: topicId
                });

            // Send additional info if it's a group message
            if (sender.endsWith('@g.us') && participant !== sender) {
                const userInfo = this.userMappings.get(participant);
                const name = userInfo?.name || participant.split('@')[0];
                
                await this.telegramBot.sendMessage(this.config.chatId, `👤 **${name}** shared a location`, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }

            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp location message:', error);
            return null;
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId) {
        try {
            const contactMessage = whatsappMsg.message.contactMessage || whatsappMsg.message.contactsArrayMessage;
            let contacts = [];
            
            if (whatsappMsg.message.contactMessage) {
                contacts = [contactMessage];
            } else if (whatsappMsg.message.contactsArrayMessage) {
                contacts = contactMessage.contacts || [];
            }
            
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            let sentMessageId = null;
            
            for (const contact of contacts) {
                const vcard = contact.vcard;
                const displayName = contact.displayName || 'Unknown Contact';
                
                let caption = `📇 Contact: ${displayName}`;
                
                // Add sender info for group messages
                if (sender.endsWith('@g.us') && participant !== sender) {
                    const userInfo = this.userMappings.get(participant);
                    const name = userInfo?.name || participant.split('@')[0];
                    caption = `👤 **${name}** shared a contact: ${displayName}`;
                }

                const sentMessage = await this.telegramBot.sendDocument(this.config.chatId, Buffer.from(vcard), {
                    message_thread_id: topicId,
                    caption: caption,
                    filename: `${displayName}.vcf`,
                    parse_mode: 'Markdown'
                });
                
                if (!sentMessageId) {
                    sentMessageId = sentMessage.message_id;
                }
            }
            
            return sentMessageId;
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
            return null;
        }
    }

    async handleTelegramMessage(msg) {
        // Skip if message has media (handled by specific media handlers)
        if (msg.photo || msg.video || msg.animation || msg.video_note || msg.voice || msg.audio || msg.document || msg.sticker || msg.location || msg.contact) {
            return;
        }

        if (!msg.text) return;
        
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            // Handle status reply
            if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
                await this.handleStatusReply(msg);
                return;
            }

            // Send presence if enabled
            if (this.config.sendMyPresence) {
                try {
                    await this.whatsappBot.sock.sendPresence('composing', whatsappJid);
                    setTimeout(async () => {
                        try {
                            await this.whatsappBot.sock.sendPresence('paused', whatsappJid);
                        } catch (error) {
                            // Ignore presence errors
                        }
                    }, 2000);
                } catch (error) {
                    // Ignore presence errors
                }
            }

            // Send to WhatsApp
            const sentMsg = await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            
            // Store message pair for revoke functionality
            if (sentMsg && sentMsg.key && sentMsg.key.id) {
                this.messagePairs.set(msg.message_id, {
                    whatsappId: sentMsg.key.id,
                    whatsappJid: whatsappJid,
                    telegramMessageId: msg.message_id,
                    timestamp: new Date()
                });
            }
            
            // Send confirmation
            await this.sendMessageConfirmation(msg);

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await this.sendErrorConfirmation(msg);
        }
    }

    async sendMessageConfirmation(msg) {
        try {
            switch (this.config.confirmationType) {
                case 'emoji':
                    if (this.config.reactions) {
                        await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '👍' }]);
                    }
                    break;
                case 'text':
                    const confirmMsg = await this.telegramBot.sendMessage(msg.chat.id, '✅ Successfully sent', {
                        message_thread_id: msg.message_thread_id,
                        disable_notification: this.config.silentConfirmation
                    });
                    // Auto-delete confirmation after 15 seconds
                    setTimeout(async () => {
                        try {
                            await this.telegramBot.deleteMessage(msg.chat.id, confirmMsg.message_id);
                        } catch (error) {
                            // Ignore deletion errors
                        }
                    }, 15000);
                    break;
                case 'none':
                default:
                    // No confirmation
                    break;
            }
        } catch (error) {
            logger.debug('Could not send confirmation:', error);
        }
    }

    async sendErrorConfirmation(msg) {
        try {
            if (this.config.reactions) {
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
            }
        } catch (error) {
            logger.debug('Could not send error confirmation:', error);
        }
    }

    async handleStatusReply(msg) {
        try {
            const originalStatusKey = this.statusMessageIds.get(msg.reply_to_message.message_id);
            if (!originalStatusKey) {
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Cannot find original status message to reply to', {
                    message_thread_id: msg.message_thread_id
                });
                return;
            }

            // Send reply to status
            const statusJid = originalStatusKey.participant || originalStatusKey.remoteJid;
            await this.whatsappBot.sendMessage(statusJid, { text: msg.text });

            // Confirm reply sent
            await this.sendMessageConfirmation(msg);
            
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await this.sendErrorConfirmation(msg);
        }
    }

    async handleTelegramMedia(msg, mediaType) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
                return;
            }

            // Check if media type is disabled
            if (this.isMediaTypeDisabled(mediaType)) {
                await this.sendErrorConfirmation(msg);
                return;
            }

            let fileId, fileName, caption = msg.caption || '';
            
            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo[msg.photo.length - 1].file_id;
                    fileName = `photo_${Date.now()}.jpg`;
                    break;
                case 'video':
                    fileId = msg.video.file_id;
                    fileName = `video_${Date.now()}.mp4`;
                    break;
                case 'animation':
                    fileId = msg.animation.file_id;
                    fileName = `animation_${Date.now()}.mp4`;
                    break;
                case 'video_note':
                    fileId = msg.video_note.file_id;
                    fileName = `video_note_${Date.now()}.mp4`;
                    break;
                case 'voice':
                    fileId = msg.voice.file_id;
                    fileName = `voice_${Date.now()}.ogg`;
                    break;
                case 'audio':
                    fileId = msg.audio.file_id;
                    fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
                    break;
                case 'document':
                    fileId = msg.document.file_id;
                    fileName = msg.document.file_name || `document_${Date.now()}`;
                    break;
                case 'sticker':
                    fileId = msg.sticker.file_id;
                    fileName = `sticker_${Date.now()}.webp`;
                    break;
            }

            // Send presence if enabled
            if (this.config.sendMyPresence) {
                try {
                    await this.whatsappBot.sock.sendPresence('composing', whatsappJid);
                } catch (error) {
                    // Ignore presence errors
                }
            }

            // Download from Telegram
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Process and send to WhatsApp based on media type
            let sentMsg = null;
            
            switch (mediaType) {
                case 'photo':
                    const processedImagePath = await this.processImage(filePath);
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, {
                        image: { url: processedImagePath },
                        caption: caption,
                        viewOnce: msg.has_media_spoiler
                    });
                    if (processedImagePath !== filePath) {
                        await fs.unlink(processedImagePath).catch(() => {});
                    }
                    break;
                    
                case 'video':
                case 'animation':
                    const processedVideoPath = await this.processVideo(filePath, { gifPlayback: mediaType === 'animation' });
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, {
                        video: { url: processedVideoPath },
                        caption: caption,
                        gifPlayback: mediaType === 'animation',
                        viewOnce: msg.has_media_spoiler
                    });
                    if (processedVideoPath !== filePath) {
                        await fs.unlink(processedVideoPath).catch(() => {});
                    }
                    break;
                    
                case 'video_note':
                    const convertedPath = await this.convertVideoNote(filePath);
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, {
                        video: { url: convertedPath },
                        ptv: true,
                        caption: caption
                    });
                    if (convertedPath !== filePath) {
                        await fs.unlink(convertedPath).catch(() => {});
                    }
                    break;
                    
                case 'voice':
                    const voicePath = await this.convertToWhatsAppVoice(filePath);
                    const waveform = this.config.generateWaveforms ? 
                        await this.generateWaveform(voicePath) : null;
                    
                    const voiceOptions = {
                        audio: { url: voicePath },
                        ptt: true
                    };
                    
                    if (waveform) {
                        voiceOptions.waveform = waveform;
                        voiceOptions.seconds = await this.getAudioDuration(voicePath);
                    }
                    
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, voiceOptions);
                    if (voicePath !== filePath) {
                        await fs.unlink(voicePath).catch(() => {});
                    }
                    break;
                    
                case 'audio':
                    const processedAudioPath = await this.processAudio(filePath, { ptt: false });
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: processedAudioPath },
                        mimetype: mime.lookup(fileName) || 'audio/mp3',
                        fileName: fileName,
                        caption: caption
                    });
                    if (processedAudioPath !== filePath) {
                        await fs.unlink(processedAudioPath).catch(() => {});
                    }
                    break;
                    
                case 'document':
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, {
                        document: { url: filePath },
                        fileName: fileName,
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        caption: caption
                    });
                    break;
                    
                case 'sticker':
                    sentMsg = await this.whatsappBot.sendMessage(whatsappJid, {
                        sticker: { url: filePath }
                    });
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            // Store message pair for revoke functionality
            if (sentMsg && sentMsg.key && sentMsg.key.id) {
                this.messagePairs.set(msg.message_id, {
                    whatsappId: sentMsg.key.id,
                    whatsappJid: whatsappJid,
                    telegramMessageId: msg.message_id,
                    timestamp: new Date()
                });
            }
            
            // Send confirmation
            await this.sendMessageConfirmation(msg);

        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            await this.sendErrorConfirmation(msg);
        }
    }

    async convertVideoNote(inputPath) {
        try {
            const outputPath = inputPath.replace(/\.[^/.]+$/, '_converted.mp4');
            
            return new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .format('mp4')
                    .outputOptions([
                        '-movflags +faststart',
                        '-vf scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2'
                    ])
                    .on('end', () => resolve(outputPath))
                    .on('error', (error) => {
                        logger.debug('Video note conversion failed:', error);
                        resolve(inputPath);
                    })
                    .save(outputPath);
            });
        } catch (error) {
            logger.debug('Could not convert video note:', error);
            return inputPath;
        }
    }

    async convertToWhatsAppVoice(inputPath) {
        try {
            const outputPath = inputPath.replace(/\.[^/.]+$/, '_voice.ogg');
            
            return new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .audioCodec('libopus')
                    .format('ogg')
                    .audioChannels(1)
                    .audioFrequency(16000)
                    .audioBitrate('24k')
                    .on('end', () => resolve(outputPath))
                    .on('error', (error) => {
                        logger.debug('Voice conversion failed:', error);
                        resolve(inputPath);
                    })
                    .save(outputPath);
            });
        } catch (error) {
            logger.debug('Could not convert to WhatsApp voice:', error);
            return inputPath;
        }
    }

    async getAudioDuration(audioPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(audioPath, (err, metadata) => {
                if (err) {
                    resolve(0);
                } else {
                    resolve(Math.floor(metadata.format.duration || 0));
                }
            });
        });
    }

    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                return;
            }

            if (this.config.skipLocations) {
                await this.sendErrorConfirmation(msg);
                return;
            }

            // Send presence if enabled
            if (this.config.sendMyPresence) {
                try {
                    await this.whatsappBot.sock.sendPresence('composing', whatsappJid);
                } catch (error) {
                    // Ignore presence errors
                }
            }

            const sentMsg = await this.whatsappBot.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude
                } 
            });

            // Store message pair
            if (sentMsg && sentMsg.key && sentMsg.key.id) {
                this.messagePairs.set(msg.message_id, {
                    whatsappId: sentMsg.key.id,
                    whatsappJid: whatsappJid,
                    telegramMessageId: msg.message_id,
                    timestamp: new Date()
                });
            }

            await this.sendMessageConfirmation(msg);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await this.sendErrorConfirmation(msg);
        }
    }

    async handleTelegramContact(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram contact');
                return;
            }

            if (this.config.skipContacts) {
                await this.sendErrorConfirmation(msg);
                return;
            }

            // Send presence if enabled
            if (this.config.sendMyPresence) {
                try {
                    await this.whatsappBot.sock.sendPresence('composing', whatsappJid);
                } catch (error) {
                    // Ignore presence errors
                }
            }

            const firstName = msg.contact.first_name || '';
            const lastName = msg.contact.last_name || '';
            const phoneNumber = msg.contact.phone_number || '';
            const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

            const sentMsg = await this.whatsappBot.sendMessage(whatsappJid, { 
                contacts: { 
                    displayName: displayName, 
                    contacts: [{ vcard: vcard }]
                } 
            });

            // Store message pair
            if (sentMsg && sentMsg.key && sentMsg.key.id) {
                this.messagePairs.set(msg.message_id, {
                    whatsappId: sentMsg.key.id,
                    whatsappJid: whatsappJid,
                    telegramMessageId: msg.message_id,
                    timestamp: new Date()
                });
            }

            await this.sendMessageConfirmation(msg);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await this.sendErrorConfirmation(msg);
        }
    }

    async handleCallbackQuery(query) {
        try {
            const data = query.data;
            
            if (data.startsWith('revoke_')) {
                const parts = data.split('_');
                if (parts.length >= 3) {
                    const messageId = parts[1];
                    const chatJid = parts[2];
                    
                    // Send revoke message to WhatsApp
                    await this.whatsappBot.sock.sendMessage(chatJid, {
                        delete: {
                            remoteJid: chatJid,
                            fromMe: true,
                            id: messageId
                        }
                    });

                    // Update the message to show it was revoked
                    await this.telegramBot.editMessageText('🗑️ **Message revoked**', {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown'
                    });

                    await this.telegramBot.answerCallbackQuery(query.id, {
                        text: '✅ Message revoked successfully'
                    });
                }
            }
        } catch (error) {
            logger.error('❌ Failed to handle callback query:', error);
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: '❌ Failed to revoke message'
            });
        }
    }

    isMediaTypeDisabled(mediaType) {
        switch (mediaType) {
            case 'photo':
                return this.config.skipImages;
            case 'video':
            case 'animation':
            case 'video_note':
                return this.config.skipVideos;
            case 'voice':
            case 'audio':
                return this.config.skipAudios;
            case 'document':
                return this.config.skipDocuments;
            case 'sticker':
                return this.config.skipStickers;
            default:
                return false;
        }
    }

    async sendSimpleMessage(topicId, text, sender, participant, whatsappMsg) {
        if (!topicId) return null;

        const chatId = this.config.chatId;
        
        try {
            let messageText = text;
            let replyMarkup = null;
            
            // Add sender info for group messages
            if (sender.endsWith('@g.us') && participant !== sender) {
                const userInfo = this.userMappings.get(participant);
                const name = userInfo?.name || participant.split('@')[0];
                messageText = `👤 **${name}**: ${text}`;
            }
            
            // Add sender info for status messages
            if (sender === 'status@broadcast') {
                const userInfo = this.userMappings.get(participant);
                const name = userInfo?.name || participant.split('@')[0];
                messageText = `👤 **${name}** (+${participant.split('@')[0]})\n\n${text}`;
            }

            // Handle view once messages
            if (whatsappMsg.message?.viewOnceMessage || whatsappMsg.message?.viewOnceMessageV2) {
                if (this.config.spoilerViewOnce) {
                    messageText = `🔒 **View Once Message**\n\n||${messageText}||`;
                } else {
                    messageText = `🔒 **View Once Message**\n\n${messageText}`;
                }
            }

            // Handle ephemeral messages
            if (whatsappMsg.message?.ephemeralMessage) {
                messageText = `⏰ **Ephemeral Message**\n\n${messageText}`;
            }

            // Add revoke button for own messages
            if (whatsappMsg.key.fromMe) {
                replyMarkup = {
                    inline_keyboard: [[{
                        text: 'Revoke',
                        callback_data: `revoke_${whatsappMsg.key.id}_${sender}`
                    }]]
                };
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, messageText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                reply_markup: replyMarkup
            });

            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to send message to Telegram:', error);
            return null;
        }
    }

    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               '';
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
        logger.info('🛑 Shutting down Enhanced Telegram bridge...');
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        // Clean up temp directory
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
        logger.info('✅ Enhanced Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;
