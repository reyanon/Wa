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
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map(); // Track active calls to prevent spam
        this.statusMessageIds = new Map(); // Track status message IDs for replies
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            // Ensure temp directory exists
            await fs.ensureDir(this.tempDir);
            
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle all types of messages
        this.telegramBot.on('message', async (msg) => {
            // Check if it's a topic message in a supergroup, or a direct message to the bot
            // Direct messages to the bot (chat.type === 'private') should also be handled.
            // For simplicity, assuming messages are handled if it's a supergroup topic message
            // or if it's a private chat that needs to be mapped to a WhatsApp JID.
            if ((msg.chat.type === 'supergroup' && msg.is_topic_message) || msg.chat.type === 'private') {
                await this.handleTelegramMsg(msg);
            }
        });

        // Specific handlers for media, location, contact, etc., if not covered by general 'message' handler
        // Ensure these don't duplicate processing with handleTelegramMsg if it's a catch-all
        // The current handleTelegramMsg checks for specific message types within itself.
        // These explicit 'on' handlers are more direct for specific message types.
        // It's good practice to have them, but make sure handleTelegramMsg doesn't re-process these.

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

        // Handle replies to status messages in Telegram
        this.telegramBot.on('message', async (msg) => {
            if (msg.reply_to_message && msg.chat.type === 'supergroup' && msg.message_thread_id === config.get('telegram.statusTopicId')) {
                await this.handleStatusReply(msg);
            }
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
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        // Handle different message types
        if (whatsappMsg.message?.imageMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage) { 
            await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.contactMessage) { 
            await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else if (text) {
            // Send text message
            const messageId = await this.sendSimpleMessage(topicId, text, sender);
            
            // Store status message ID for reply handling
            if (sender === 'status@broadcast') {
                this.statusMessageIds.set(messageId, whatsappMsg.key);
            }
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

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
            messageCount: 0
        });

        logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`);
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
        if (!config.get('telegram.settings.enableCallNotifications', true)) return;
        if (!this.telegramBot || !config.get('telegram.settings.syncCalls')) return;

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
            const callType = callEvent.isVideo ? '📹 Video' : '📞 Voice';
            const status = callEvent.status === 'offer' ? 'Incoming' : 
                            callEvent.status === 'accept' ? 'Accepted' : 
                            callEvent.status === 'reject' ? 'Rejected' : 'Ended';

            // Get or create call topic
            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast', participant: callerId }
            });

            const callMessage = `${callType} Call ${status}\n\n` +
                                `👤 **Caller:** ${callerName}\n` +
                                `📱 **Number:** +${callerId.split('@')[0]}\n` +
                                `⏰ **Time:** ${new Date().toLocaleString()}\n` +
                                `📊 **Status:** ${status}`;

            await this.telegramBot.sendMessage(config.get('telegram.chatId'), callMessage, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            logger.debug(`📞 Sent call notification: ${callType} ${status} from ${callerName}`);
        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            let caption = this.extractText(whatsappMsg); // Calls extractText method
            
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

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream); // Calls streamToBuffer method
            
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
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp location message:', error);
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId) {
        try {
            const contactMessage = whatsappMsg.message.contactMessage;
            const vcard = contactMessage.vcard;
            const displayName = contactMessage.displayName || 'Unknown Contact';

            await this.telegramBot.sendDocument(config.get('telegram.chatId'), Buffer.from(vcard), {
                message_thread_id: topicId,
                caption: `📇 Contact: ${displayName}`,
                filename: `${displayName}.vcf`
            });
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
        }
    }

    async handleTelegramMsg(msg) {
        try {
            if (!msg) return;

            const whatsappChatJid = this.mapTelegramChatToWhatsApp(msg.message_thread_id || msg.chat.id); // Use topic ID if available, else chat ID
            if (!whatsappChatJid) {
                logger.warn(`⚠️ Could not map Telegram chat ID ${msg.chat.id} (or topic ${msg.message_thread_id}) to WhatsApp JID.`);
                return;
            }

            // Handle albums (media groups) - node-telegram-bot-api handles these with 'mediaGroup' event
            if (msg.media_group_id) {
                // If you have a separate 'mediaGroup' handler, you can skip here.
                // Otherwise, you'd need to collect messages belonging to the same media group
                // and send them as an album to WhatsApp. For simplicity, we'll assume
                // handleTelegramMedia handles individual media within a group.
                logger.debug('Skipping message that is part of a media group, will be handled by specific media handlers if configured.');
                return;
            }

            // Handle text messages with spoiler formatting
            if (msg.text) {
                const text = msg.text.trim();

                // Detect Telegram spoiler markdown: ||spoiler||
                const isSpoiler = text.startsWith('||') && text.endsWith('||');
                if (isSpoiler) {
                    const spoilerText = text.slice(2, -2).trim();

                    // Send as WhatsApp view once message (imageMessage with caption as workaround)
                    await this.whatsappBot.sock.sendMessage(whatsappChatJid, {
                        viewOnceMessage: {
                            message: {
                                imageMessage: {
                                    caption: spoilerText,
                                    jpegThumbnail: Buffer.alloc(0) // empty thumbnail placeholder
                                }
                            }
                        }
                    });
                    return;
                }

                // Normal text forwarding
                await this.whatsappBot.sock.sendMessage(whatsappChatJid, { text });
                return;
            }

            // Handle media messages (photo, video, audio, voice, document, sticker)
            // The specific 'on' handlers for each media type will call handleTelegramMedia directly.
            // If this general handler is called and msg.media is present, it means the specific handler didn't fire,
            // or we need a fallback.
            if (msg.photo || msg.video || msg.voice || msg.audio || msg.document || msg.sticker || msg.video_note) {
                 // The specific handlers should catch these first. If we reach here,
                 // it's a fallback or a type not explicitly caught by 'on' handlers.
                 // The handleTelegramMedia is called by the specific handlers above.
                 // This block can be removed if all media types are covered by specific on handlers.
                 logger.debug('Media message received, expecting specific handler to process:', msg);
                 return;
            }

            // Handle location and contact messages if not already handled by specific 'on' handlers
            if (msg.location) {
                await this.handleTelegramLocation(msg);
                return;
            }
            if (msg.contact) {
                await this.handleTelegramContact(msg);
                return;
            }

            // If no recognized content, ignore or log
            logger.info('Unhandled Telegram message type:', msg);
        } catch (error) {
            logger.error('Error handling Telegram message:', error);
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
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '✅' }]);
            
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
        }
    }

    async handleTelegramMedia(msg, mediaType) { // mediaType passed from specific telegramBot.on handlers
        let fileId = null;
        let mimeType = null;
        let fileName = null;
        let caption = msg.caption || '';
        let whatsappMsgPayload = null;

        if (mediaType === 'photo') {
            const photos = msg.photo;
            fileId = photos[photos.length - 1].file_id; // Get highest quality photo
            mimeType = 'image/jpeg'; // Telegram photos are usually JPEG
            fileName = `${fileId}.jpg`;
        } else if (mediaType === 'video') {
            fileId = msg.video.file_id;
            mimeType = msg.video.mime_type || 'video/mp4';
            fileName = msg.video.file_name || `${fileId}.mp4`;
        } else if (mediaType === 'voice') {
            fileId = msg.voice.file_id;
            mimeType = msg.voice.mime_type || 'audio/ogg';
            fileName = `${fileId}.ogg`;
        } else if (mediaType === 'audio') {
            fileId = msg.audio.file_id;
            mimeType = msg.audio.mime_type || 'audio/mpeg';
            fileName = msg.audio.file_name || `${fileId}.mp3`;
        } else if (mediaType === 'document') {
            fileId = msg.document.file_id;
            mimeType = msg.document.mime_type || 'application/octet-stream';
            fileName = msg.document.file_name || `${fileId}.${mime.extension(mimeType) || 'bin'}`;
        } else if (mediaType === 'sticker') {
            fileId = msg.sticker.file_id;
            mimeType = msg.sticker.mime_type || 'image/webp';
            fileName = `${fileId}.webp`;
        } else if (mediaType === 'video_note') {
            fileId = msg.video_note.file_id;
            mimeType = msg.video_note.mime_type || 'video/mp4'; // Video notes are typically mp4
            fileName = `${fileId}.mp4`;
        } else {
            logger.warn('Unsupported Telegram media type received:', mediaType);
            return;
        }

        if (!fileId) {
            logger.error('Could not get fileId for Telegram media.');
            return;
        }

        const telegramChatId = msg.chat.id;
        const topicId = msg.message_thread_id;
        const whatsappChatJid = this.findWhatsAppJidByTopic(topicId); // Map Telegram topic to WhatsApp JID

        if (!whatsappChatJid) {
            logger.warn(`⚠️ Could not find WhatsApp chat for Telegram media (chat ID: ${telegramChatId}, topic ID: ${topicId}).`);
            await this.telegramBot.sendMessage(telegramChatId, '❌ Could not find corresponding WhatsApp chat to forward this message.', {
                message_thread_id: topicId
            });
            return;
        }

        // Download media locally
        const fileLink = await this.telegramBot.getFileLink(fileId);
        const filePath = path.join(this.tempDir, fileName);

        try {
            await this.downloadFile(fileLink, filePath); // Use downloadFile utility method

            // Prepare WhatsApp message payload based on media type
            if (mediaType === 'photo') {
                whatsappMsgPayload = { image: { url: filePath }, caption: caption };
            } else if (mediaType === 'video') {
                whatsappMsgPayload = { video: { url: filePath }, caption: caption, mimetype: mimeType };
            } else if (mediaType === 'voice') {
                // Convert to WhatsApp compatible voice note (OPUS)
                const whatsappVoicePath = path.join(this.tempDir, `${fileId}_wa_voice.ogg`);
                await this.convertToWhatsAppVoice(filePath, whatsappVoicePath);
                const waveform = await this.generateWaveform(whatsappVoicePath);
                whatsappMsgPayload = { audio: { url: whatsappVoicePath, ptt: true, waveform: waveform }, mimetype: 'audio/ogg; codecs=opus' };
            } else if (mediaType === 'audio') {
                whatsappMsgPayload = { audio: { url: filePath }, caption: caption, mimetype: mimeType };
            } else if (mediaType === 'document') {
                whatsappMsgPayload = { document: { url: filePath, fileName: fileName, mimetype: mimeType }, caption: caption };
            } else if (mediaType === 'sticker') {
                whatsappMsgPayload = { sticker: { url: filePath } };
            } else if (mediaType === 'video_note') {
                // Convert video note to a WhatsApp friendly format (mp4 with specific dimensions)
                const whatsappVideoNotePath = path.join(this.tempDir, `${fileId}_wa_videonote.mp4`);
                await this.convertVideoNote(filePath, whatsappVideoNotePath);
                whatsappMsgPayload = { video: { url: whatsappVideoNotePath, gifPlayback: true }, mimetype: 'video/mp4' };
            }

            if (!whatsappMsgPayload) {
                logger.warn('No WhatsApp message payload created for Telegram media type:', mediaType);
                return;
            }

            // Send media message to WhatsApp
            const sentWaMsg = await this.whatsappBot.sock.sendMessage(whatsappChatJid, whatsappMsgPayload);

            // React to the Telegram message to confirm forwarding
            if (sentWaMsg) {
                await this.telegramBot.setMessageReaction(telegramChatId, msg.message_id, [{ type: 'emoji', emoji: '👍' }], { message_thread_id: topicId });
            }

        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType} message:`, error);
            await this.telegramBot.setMessageReaction(telegramChatId, msg.message_id, [{ type: 'emoji', emoji: '❌' }], { message_thread_id: topicId });
        } finally {
            // Clean up temp files
            await fs.unlink(filePath).catch(() => {});
            // If voice or video note, also clean up converted files
            if (mediaType === 'voice') {
                await fs.unlink(path.join(this.tempDir, `${fileId}_wa_voice.ogg`)).catch(() => {});
            }
            if (mediaType === 'video_note') {
                await fs.unlink(path.join(this.tempDir, `${fileId}_wa_videonote.mp4`)).catch(() => {});
            }
        }
    }
    
    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not find corresponding WhatsApp chat to forward this location.', {
                    message_thread_id: topicId
                });
                return;
            }

            await this.whatsappBot.sock.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude
                } 
            });

            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '👍' }], { message_thread_id: topicId });
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }], { message_thread_id: topicId });
        }
    }

    async handleTelegramContact(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram contact');
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not find corresponding WhatsApp chat to forward this contact.', {
                    message_thread_id: topicId
                });
                return;
            }

            const firstName = msg.contact.first_name || '';
            const lastName = msg.contact.last_name || '';
            const phoneNumber = msg.contact.phone_number || '';
            const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

            await this.whatsappBot.sock.sendMessage(whatsappJid, { 
                contacts: { 
                    displayName: displayName, 
                    contacts: [{ vcard: vcard }]
                } 
            });

            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '👍' }], { message_thread_id: topicId });
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }], { message_thread_id: topicId });
        }
    }

    async convertVideoNote(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .format('mp4')
                .outputOptions([
                    '-movflags +faststart',
                    // Scale to 640x640, maintaining aspect ratio and padding if needed
                    '-vf scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2'
                ])
                .on('end', () => {
                    logger.debug(`Video note converted: ${inputPath} -> ${outputPath}`);
                    resolve();
                })
                .on('error', (err) => {
                    logger.error(`Error converting video note ${inputPath}:`, err);
                    reject(err);
                })
                .save(outputPath);
        });
    }

    async convertToWhatsAppVoice(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioCodec('libopus')
                .format('ogg')
                .audioChannels(1)
                .audioFrequency(16000)
                .audioBitrate('24k')
                .on('end', () => {
                    logger.debug(`Audio converted to WhatsApp voice: ${inputPath} -> ${outputPath}`);
                    resolve();
                })
                .on('error', (err) => {
                    logger.error(`Error converting audio to WhatsApp voice ${inputPath}:`, err);
                    reject(err);
                })
                .save(outputPath);
        });
    }

    async generateWaveform(audioPath) {
        try {
            const duration = await this.getAudioDuration(audioPath);
            const samples = Math.min(Math.floor(duration), 60); // Max 60 samples for waveform
            const waveform = [];
            
            // Generate random values for waveform (placeholder logic)
            // A more advanced implementation would analyze audio amplitude
            for (let i = 0; i < samples; i++) {
                waveform.push(Math.floor(Math.random() * 100) + 1); // Values 1-100
            }
            
            return Buffer.from(waveform);
        } catch (error) {
            logger.warn('Could not generate waveform, using default:', error.message);
            return Buffer.from([50, 75, 25, 100, 60, 80, 40, 90, 30, 70]); // Default waveform
        }
    }

    async getAudioDuration(audioPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(audioPath, (err, metadata) => {
                if (err) {
                    logger.error(`Error getting audio duration for ${audioPath}:`, err);
                    reject(err);
                } else {
                    resolve(Math.floor(metadata.format.duration || 0));
                }
            });
        });
    }

    async sendSimpleMessage(topicId, text, sender) {
        if (!topicId) return null;

        const chatId = config.get('telegram.chatId');
        
        try {
            // Add sender info for status messages
            let messageText = text;
            if (sender === 'status@broadcast') {
                const participant = this.findParticipantFromStatusMessage(text); // Needs to be defined
                if (participant) {
                    const userInfo = this.userMappings.get(participant);
                    const name = userInfo?.name || participant.split('@')[0];
                    messageText = `👤 **${name}** (+${participant.split('@')[0]})\n\n${text}`;
                }
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, messageText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to send simple message to Telegram:', error);
            return null;
        }
    }

    // Utility to download a file from URL to local path
    async downloadFile(url, dest) {
        const writer = fs.createWriteStream(dest);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                logger.error(`Error downloading file from ${url} to ${dest}:`, err);
                reject(err);
            });
        });
    }

    // Maps a Telegram chat ID (or topic ID) to a WhatsApp JID
    mapTelegramChatToWhatsApp(telegramChatIdentifier) {
        // This mapping logic needs to be robust based on how your system links them.
        // If a direct map from config is used:
        const map = config.get('telegram.telegramToWhatsAppMap') || {};
        // Check if the identifier is a topic ID first (which is a number)
        if (typeof telegramChatIdentifier === 'number') {
            // Reverse lookup: Find WA JID by Telegram Topic ID
            for (let [waJid, tgTopicId] of this.chatMappings.entries()) {
                if (tgTopicId === telegramChatIdentifier) {
                    return waJid;
                }
            }
        }
        // Fallback or if direct chat ID is used for private chats
        return map[telegramChatIdentifier] || null; // Return null if no mapping found
    }

    // Finds WhatsApp JID given a Telegram topic ID (inverse of this.chatMappings)
    findWhatsAppJidByTopic(telegramTopicId) {
        for (let [waJid, tgTopicId] of this.chatMappings.entries()) {
            if (tgTopicId === telegramTopicId) {
                return waJid;
            }
        }
        return null;
    }

    // Extracts text caption from a WhatsApp message object
    extractText(whatsappMsg) {
        if (whatsappMsg.message?.conversation) {
            return whatsappMsg.message.conversation;
        }
        if (whatsappMsg.message?.extendedTextMessage?.text) {
            return whatsappMsg.message.extendedTextMessage.text;
        }
        if (whatsappMsg.message?.imageMessage?.caption) {
            return whatsappMsg.message.imageMessage.caption;
        }
        if (whatsappMsg.message?.videoMessage?.caption) {
            return whatsappMsg.message.videoMessage.caption;
        }
        if (whatsappMsg.message?.documentMessage?.caption) {
            return whatsappMsg.message.documentMessage.caption;
        }
        if (whatsappMsg.message?.stickerMessage?.caption) { // Stickers can have captions
            return whatsappMsg.message.stickerMessage.caption;
        }
        return '';
    }

    // Converts a readable stream to a Buffer
    streamToBuffer(stream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
        });
    }

    // Placeholder for finding participant from status message text
    findParticipantFromStatusMessage(text) {
        // This is a placeholder. You need to implement logic to reliably extract
        // a WhatsApp JID or phone number from the text of a status message.
        // Example: if your status messages are formatted like "New status from +1234567890: Bla bla"
        const match = text.match(/\+\(?(\d{1,})\)?[\s-]?(\d{1,})[\s-]?(\d{1,})@s\.whatsapp\.net/); // Simple regex for common phone number formats in JID
        if (match) {
            // Reconstruct the full JID from the matched parts if necessary, or just return the relevant group
            // For example, if it's always in the format '1234567890@s.whatsapp.net'
            const phoneNumber = match[1] + match[2] + match[3]; // Combine groups if phone number is split by spaces/dashes
            return `${phoneNumber}@s.whatsapp.net`;
        }
        
        // As a very loose fallback, try to find any number that looks like a phone number and append WhatsApp suffix
        const potentialPhoneMatch = text.match(/\b(\d{10,15})\b/); // Looks for 10-15 digit numbers
        if (potentialPhoneMatch && potentialPhoneMatch[1]) {
            return `${potentialPhoneMatch[1]}@s.whatsapp.net`;
        }

        logger.debug('Could not extract participant from status message text:', text);
        return null; // Return null if no participant can be reliably found
    }
}

module.exports = TelegramBridge;
