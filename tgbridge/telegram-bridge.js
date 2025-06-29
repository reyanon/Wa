const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map(); // Track active calls to prevent spam
        this.statusMessageIds = new Map(); // Track status message IDs for replies
        this.presenceTimeout = null; // For managing presence
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId');
        
        if (!token || token.includes('YOUR_BOT_TOKEN') || !chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly');
            return;
        }

        try {
            // Ensure temp directory exists
            await fs.ensureDir(this.tempDir);
            
            // Test bot token first
            const testResponse = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
            if (!testResponse.data.ok) {
                throw new Error('Invalid bot token');
            }
            
            logger.info(`🤖 Bot token valid: @${testResponse.data.result.username}`);
            
            this.telegramBot = new TelegramBot(token, { 
                polling: {
                    interval: 1000,
                    autoStart: true,
                    params: {
                        timeout: 10
                    }
                }
            });
            
            // Test chat access
            try {
                await this.telegramBot.getChat(chatId);
                logger.info(`💬 Chat access confirmed: ${chatId}`);
            } catch (chatError) {
                logger.error(`❌ Cannot access chat ${chatId}:`, chatError.message);
                return;
            }
            
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized successfully');
            
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error.message);
            
            // Don't throw error, just disable the bridge
            this.telegramBot = null;
        }
    }

    async setReaction(chatId, messageId, emoji) {
        try {
            const token = config.get('telegram.botToken');
            await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji }]
            });
        } catch (err) {
            logger.debug('❌ Failed to set reaction via HTTP API:', err?.response?.data?.description || err.message);
        }
    }

    async setupTelegramHandlers() {
        // Handle all types of messages with error wrapping
        this.telegramBot.on('message', this.wrapHandler(async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        }));

        // Handle polling errors
        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
        });

        // Handle general errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    // Wrapper to catch unhandled promise rejections
    wrapHandler(handler) {
        return async (...args) => {
            try {
                await handler(...args);
            } catch (error) {
                logger.error('❌ Unhandled error in Telegram handler:', error);
            }
        };
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('YOUR_LOG_CHANNEL')) {
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

        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            logger.debug(`📨 Processing WhatsApp message from ${sender}`, {
                messageType: Object.keys(whatsappMsg.message || {}),
                hasText: !!text,
                participant
            });
            
            // Create user mapping if not exists
            await this.createUserMapping(participant, whatsappMsg);
            
            // Get or create topic for this chat
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            if (!topicId) {
                logger.error('❌ Could not get or create topic for message');
                return;
            }
            
            // Handle different message types - check the actual message structure
            const message = whatsappMsg.message;
            if (!message) {
                logger.debug('⚠️ No message content found');
                return;
            }

            // Check for media messages first
            if (message.imageMessage) {
                logger.info('📸 Processing image message');
                await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
            } else if (message.videoMessage) {
                logger.info('🎥 Processing video message');
                await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
            } else if (message.audioMessage) {
                logger.info('🎵 Processing audio message');
                await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
            } else if (message.documentMessage) {
                logger.info('📄 Processing document message');
                await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
            } else if (message.stickerMessage) {
                logger.info('🎭 Processing sticker message');
                await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
            } else if (message.locationMessage) { 
                logger.info('📍 Processing location message');
                await this.handleWhatsAppLocation(whatsappMsg, topicId);
            } else if (message.contactMessage || message.contactsArrayMessage) { 
                logger.info('👤 Processing contact message');
                await this.handleWhatsAppContact(whatsappMsg, topicId);
            } else if (text) {
                // Send text message
                logger.info('💬 Processing text message');
                const messageId = await this.sendSimpleMessage(topicId, text, sender);
                
                // Store status message ID for reply handling
                if (sender === 'status@broadcast') {
                    this.statusMessageIds.set(messageId, whatsappMsg.key);
                }
            } else {
                logger.debug('⚠️ Unknown message type:', Object.keys(message));
            }
        } catch (error) {
            logger.error('❌ Error in syncMessage:', error);
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        // Extract user info from WhatsApp
        let userName = null;
        let userPhone = participant.split('@')[0];
        
        try {
            // Try to get pushname from message
            if (whatsappMsg.pushName) {
                userName = whatsappMsg.pushName;
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

        logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`);
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.error('❌ Telegram chat ID not configured properly');
            return null;
        }

        if (!this.telegramBot) {
            logger.warn('⚠️ Telegram bot not initialized');
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
                // For individual chats
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                const phone = participant.split('@')[0];
                
                if (userInfo && userInfo.name) {
                    topicName = userInfo.name;
                } else {
                    topicName = phone;
                }
            }

            // Create forum topic with retry logic
            let topic;
            let retries = 3;
            
            while (retries > 0) {
                try {
                    topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                        icon_color: iconColor
                    });
                    break; // Success, exit retry loop
                } catch (error) {
                    retries--;
                    if (retries === 0) throw error;
                    
                    logger.warn(`⚠️ Retry creating topic (${3 - retries}/3):`, error.message);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                }
            }

            if (!topic || !topic.message_thread_id) {
                logger.error('❌ Failed to create topic - invalid response:', topic);
                return null;
            }

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message after a delay
            setTimeout(() => {
                if (!isStatus && !isCall) {
                    this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup);
                }
            }, 1000);
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, jid, isGroup) {
        try {
            const chatId = config.get('telegram.chatId');
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
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            
            if (profilePicUrl) {
                const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
                
                await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
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
        if (!this.telegramBot) return;

        const callerId = callEvent.from;
        const callKey = `${callerId}_${callEvent.id}`;

        // Prevent spam - only send one notification per call
        if (this.activeCallNotifications.has(callKey)) return;
        
        this.activeCallNotifications.set(callKey, true);
        
        // Clear after 30 seconds
        setTimeout(() => {
            this.activeCallNotifications.delete(callKey);
        }, 30000);

        try {
            const userInfo = this.userMappings.get(callerId);
            const callerName = userInfo?.name || callerId.split('@')[0];
            
            // Get or create call topic
            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast', participant: callerId }
            });

            const callMessage = `📞 Incoming call from +${callerId.split('@')[0]}`;

            await this.telegramBot.sendMessage(config.get('telegram.chatId'), callMessage, {
                message_thread_id: topicId
            });

            logger.debug(`📞 Sent call notification from ${callerName}`);
        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            logger.info(`📥 Processing ${mediaType} from WhatsApp`);
            
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

            if (!mediaMessage) {
                logger.error(`❌ No ${mediaType} message found in WhatsApp message`);
                return;
            }

            logger.info(`📥 Downloading ${mediaType} from WhatsApp...`);

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            
            logger.info(`💾 Downloaded ${mediaType}: ${buffer.length} bytes`);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to Telegram based on media type
            const chatId = config.get('telegram.chatId');
            
            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(chatId, filePath, {
                        message_thread_id: topicId,
                        caption: caption
                    });
                    break;
                    
                case 'video':
                    await this.telegramBot.sendVideo(chatId, filePath, {
                        message_thread_id: topicId,
                        caption: caption
                    });
                    break;
                    
                case 'audio':
                    if (mediaMessage.ptt) {
                        await this.telegramBot.sendVoice(chatId, filePath, {
                            message_thread_id: topicId,
                            caption: caption
                        });
                    } else {
                        await this.telegramBot.sendAudio(chatId, filePath, {
                            message_thread_id: topicId,
                            caption: caption
                        });
                    }
                    break;
                    
                case 'document':
                    await this.telegramBot.sendDocument(chatId, filePath, {
                        message_thread_id: topicId,
                        caption: caption
                    });
                    break;
                    
                case 'sticker':
                    try {
                        await this.telegramBot.sendSticker(chatId, filePath, {
                            message_thread_id: topicId
                        });
                    } catch (stickerError) {
                        logger.debug('Failed to send as sticker, converting to PNG:', stickerError.message);
                        const pngPath = filePath.replace('.webp', '.png');
                        await sharp(filePath).png().toFile(pngPath);
                        
                        await this.telegramBot.sendPhoto(chatId, pngPath, {
                            message_thread_id: topicId,
                            caption: caption || 'Sticker'
                        });
                        await fs.unlink(pngPath).catch(() => {});
                    }
                    break;
            }

            logger.info(`✅ Successfully sent ${mediaType} to Telegram`);

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const locationMessage = whatsappMsg.message.locationMessage;
            await this.telegramBot.sendLocation(config.get('telegram.chatId'), 
                locationMessage.degreesLatitude, 
                locationMessage.degreesLongitude, {
                    message_thread_id: topicId
                });
            logger.info('✅ Successfully sent location to Telegram');
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp location message:', error);
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId) {
        try {
            const contactMessage = whatsappMsg.message.contactMessage || whatsappMsg.message.contactsArrayMessage;
            
            if (whatsappMsg.message.contactMessage) {
                // Single contact
                const vcard = contactMessage.vcard;
                const displayName = contactMessage.displayName || 'Unknown Contact';

                await this.telegramBot.sendDocument(config.get('telegram.chatId'), Buffer.from(vcard), {
                    message_thread_id: topicId,
                    caption: `📇 Contact: ${displayName}`,
                    filename: `${displayName}.vcf`
                });
            } else if (whatsappMsg.message.contactsArrayMessage) {
                // Multiple contacts
                const contacts = contactMessage.contacts || [];
                for (const contact of contacts) {
                    const vcard = contact.vcard;
                    const displayName = contact.displayName || 'Unknown Contact';

                    await this.telegramBot.sendDocument(config.get('telegram.chatId'), Buffer.from(vcard), {
                        message_thread_id: topicId,
                        caption: `📇 Contact: ${displayName}`,
                        filename: `${displayName}.vcf`
                    });
                }
            }
            
            logger.info('✅ Successfully sent contact(s) to Telegram');
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
        }
    }

    // Send presence when user is typing/active in Telegram
    async sendPresence(jid, isTyping = false) {
        try {
            if (!this.whatsappBot.sock) return;
            
            const presence = isTyping ? 'composing' : 'available';
            await this.whatsappBot.sock.sendPresenceUpdate(presence, jid);
            
            logger.debug(`📡 Sent presence ${presence} to ${jid}`);
            
            // Clear previous timeout
            if (this.presenceTimeout) {
                clearTimeout(this.presenceTimeout);
            }
            
            // Set presence back to unavailable after 10 seconds
            this.presenceTimeout = setTimeout(async () => {
                try {
                    await this.whatsappBot.sock.sendPresenceUpdate('unavailable', jid);
                    logger.debug(`📡 Sent presence unavailable to ${jid}`);
                } catch (error) {
                    logger.debug('Failed to send unavailable presence:', error);
                }
            }, 10000);
            
        } catch (error) {
            logger.debug('Failed to send presence:', error);
        }
    }

    // Mark messages as read in WhatsApp
    async markAsRead(jid, messageKeys) {
        try {
            if (!this.whatsappBot.sock || !messageKeys.length) return;
            
            await this.whatsappBot.sock.readMessages(messageKeys);
            logger.debug(`📖 Marked ${messageKeys.length} messages as read in ${jid}`);
        } catch (error) {
            logger.debug('Failed to mark messages as read:', error);
        }
    }

    async handleTelegramMessage(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            logger.info(`📤 Processing Telegram message to ${whatsappJid}`);

            // Send presence when user is active
            await this.sendPresence(whatsappJid, false);

            // Handle different message types
            if (msg.photo) {
                await this.handleTelegramMedia(msg, 'photo');
            } else if (msg.video) {
                await this.handleTelegramMedia(msg, 'video');
            } else if (msg.video_note) {
                await this.handleTelegramMedia(msg, 'video_note');
            } else if (msg.voice) {
                await this.handleTelegramMedia(msg, 'voice');
            } else if (msg.audio) {
                await this.handleTelegramMedia(msg, 'audio');
            } else if (msg.document) {
                await this.handleTelegramMedia(msg, 'document');
            } else if (msg.sticker) {
                await this.handleTelegramMedia(msg, 'sticker');
            } else if (msg.location) {
                await this.handleTelegramLocation(msg);
            } else if (msg.contact) {
                await this.handleTelegramContact(msg);
            } else if (msg.text) {
                // Handle status reply
                if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
                    await this.handleStatusReply(msg);
                    return;
                }

                // Send typing presence
                await this.sendPresence(whatsappJid, true);

                // Send text message to WhatsApp
                const messageOptions = { text: msg.text };
                
                // Handle spoiler messages (messages with spoiler entities)
                if (msg.entities && msg.entities.some(entity => entity.type === 'spoiler')) {
                    // For spoiler messages, we can add a special marker or send as view once
                    messageOptions.text = `🫥 ${msg.text}`;
                }

                const sendResult = await this.whatsappBot.sendMessage(whatsappJid, messageOptions);
                
                if (sendResult?.key?.id) {
                    await this.setReaction(msg.chat.id, msg.message_id, '👍');
                    logger.info('✅ Successfully sent text message to WhatsApp');
                    
                    // Mark the sent message as read immediately (simulating read receipt)
                    setTimeout(async () => {
                        await this.markAsRead(whatsappJid, [sendResult.key]);
                    }, 1000);
                }
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
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
            await this.setReaction(msg.chat.id, msg.message_id, '✅');
            
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
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

            // Send presence when user is sending media
            await this.sendPresence(whatsappJid, false);

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

            logger.info(`📥 Downloading ${mediaType} from Telegram: ${fileName}`);

            // Download from Telegram
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            logger.info(`💾 Saved ${mediaType} to: ${filePath} (${buffer.length} bytes)`);

            // Send to WhatsApp based on media type
            let sendResult;
            let messageOptions = {};

            // Handle spoiler media (if message has spoiler caption)
            const hasMediaSpoiler = msg.has_media_spoiler || 
                (msg.caption_entities && msg.caption_entities.some(entity => entity.type === 'spoiler'));

            switch (mediaType) {
                case 'photo':
                    messageOptions = {
                        image: fs.readFileSync(filePath),
                        caption: caption,
                        viewOnce: hasMediaSpoiler // Send as view once if spoiler
                    };
                    break;
                    
                case 'video':
                case 'video_note':
                    messageOptions = {
                        video: fs.readFileSync(filePath),
                        caption: caption,
                        ptv: mediaType === 'video_note', // Push-to-talk video for video notes
                        viewOnce: hasMediaSpoiler // Send as view once if spoiler
                    };
                    break;
                    
                case 'voice':
                    messageOptions = {
                        audio: fs.readFileSync(filePath),
                        ptt: true, // Push-to-talk for voice messages
                        mimetype: 'audio/ogg; codecs=opus'
                    };
                    break;
                    
                case 'audio':
                    messageOptions = {
                        audio: fs.readFileSync(filePath),
                        mimetype: mime.lookup(fileName) || 'audio/mp3',
                        fileName: fileName,
                        caption: caption
                    };
                    break;
                    
                case 'document':
                    messageOptions = {
                        document: fs.readFileSync(filePath),
                        fileName: fileName,
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        caption: caption
                    };
                    break;
                    
                case 'sticker':
                    messageOptions = {
                        sticker: fs.readFileSync(filePath)
                    };
                    break;
            }

            sendResult = await this.whatsappBot.sendMessage(whatsappJid, messageOptions);

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            // React with thumbs up when media is delivered to WhatsApp
            if (sendResult?.key?.id) {
                logger.info(`✅ Successfully sent ${mediaType} to WhatsApp`);
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                
                // Mark as read after sending
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            } else {
                logger.warn(`⚠️ Failed to send ${mediaType} to WhatsApp - no message ID returned`);
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
            }

        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                return;
            }

            await this.sendPresence(whatsappJid, false);

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude
                } 
            });

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
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

            await this.sendPresence(whatsappJid, false);

            const firstName = msg.contact.first_name || '';
            const lastName = msg.contact.last_name || '';
            const phoneNumber = msg.contact.phone_number || '';
            const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                contacts: { 
                    displayName: displayName, 
                    contacts: [{ vcard: vcard }]
                } 
            });

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async sendSimpleMessage(topicId, text, sender) {
        if (!topicId) return null;

        const chatId = config.get('telegram.chatId');
        
        try {
            // Add sender info for status messages
            let messageText = text;
            if (sender === 'status@broadcast') {
                messageText = `📱 Status from +${sender.split('@')[0]}\n\n${text}`;
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, messageText, {
                message_thread_id: topicId
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

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `🚀 Ready to bridge messages!`);
    }

    // Setup WhatsApp event handlers
    setupWhatsAppHandlers() {
        if (!this.whatsappBot.sock) return;

        // Handle call events
        this.whatsappBot.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                await this.handleCallNotification(call);
            }
        });

        logger.info('📱 WhatsApp event handlers set up for Telegram bridge');
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        // Clear presence timeout
        if (this.presenceTimeout) {
            clearTimeout(this.presenceTimeout);
        }
        
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
        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;
