const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Mock config and logger for standalone operation
const config = {
    get: (key, defaultValue) => {
        const configs = {
            'telegram.botToken': process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE',
            'telegram.chatId': process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE',
            'telegram.logChannel': process.env.TELEGRAM_LOG_CHANNEL || '',
            'telegram.enabled': true,
            'telegram.ownerIds': [parseInt(process.env.TELEGRAM_OWNER_ID) || 123456789],
            'telegram.sudoUsers': [],
            'telegram.spoilerViewOnce': true,
            'telegram.reactions': true,
            'telegram.confirmationType': 'emoji', // emoji, text, none
            'bot.name': 'WhatsApp Bridge Bot',
            'bot.version': '2.0.0',
            'bot.prefix': '!'
        };
        return configs[key] !== undefined ? configs[key] : defaultValue;
    }
};

const logger = {
    info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
    debug: (msg, ...args) => console.debug(`[DEBUG] ${msg}`, ...args)
};

// Set ffmpeg path if available
if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.name = 'telegram-bridge';
        this.version = '2.0.0';
        this.description = 'Complete Telegram Bridge with Spoiler Media and Reaction Confirmations';
        
        // Core properties
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.messagePairs = new Map(); // Telegram Message ID -> WhatsApp Message Info
        this.userMappings = new Map(); // WhatsApp User -> Contact Info
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.activeCallNotifications = new Map();
        this.statusMessageIds = new Map();
        this.callHistory = new Map();
        
        // Configuration
        this.config = {
            botToken: config.get('telegram.botToken'),
            chatId: config.get('telegram.chatId'),
            logChannel: config.get('telegram.logChannel'),
            enabled: config.get('telegram.enabled', true),
            ownerIds: config.get('telegram.ownerIds', []),
            sudoUsers: config.get('telegram.sudoUsers', []),
            spoilerViewOnce: config.get('telegram.spoilerViewOnce', true),
            reactions: config.get('telegram.reactions', true),
            confirmationType: config.get('telegram.confirmationType', 'emoji')
        };

        this.startTime = new Date();
        this.stats = {
            messagesForwarded: 0,
            mediaForwarded: 0,
            topicsCreated: 0,
            callsLogged: 0,
            errors: 0
        };
    }

    async initialize() {
        logger.info('🔧 Initializing Telegram Bridge...');
        
        try {
            await fs.ensureDir(this.tempDir);
            
            if (this.isProperlyConfigured()) {
                await this.initializeTelegramBot();
                logger.info('✅ Telegram bridge initialized successfully');
            } else {
                logger.warn('⚠️ Telegram bridge not started - check configuration');
                logger.info('Please set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_OWNER_ID environment variables');
            }
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram Bridge:', error);
        }
    }

    async initializeTelegramBot() {
        try {
            this.telegramBot = new TelegramBot(this.config.botToken, { 
                polling: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    }
                }
            });
            
            await this.setupTelegramHandlers();
            await this.sendStartupMessage();
            
            logger.info('✅ Telegram bot started successfully');
            return true;
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bot:', error);
            return false;
        }
    }

    async setupTelegramHandlers() {
        // Handle all message types
        this.telegramBot.on('message', async (msg) => {
            try {
                if (this.shouldProcessTelegramMessage(msg)) {
                    await this.handleTelegramMessage(msg);
                }
            } catch (error) {
                logger.error('Error handling Telegram message:', error);
                this.stats.errors++;
            }
        });

        // Handle callback queries for revoke buttons
        this.telegramBot.on('callback_query', async (query) => {
            try {
                await this.handleCallbackQuery(query);
            } catch (error) {
                logger.error('Error handling callback query:', error);
            }
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    shouldProcessTelegramMessage(msg) {
        return msg.chat.type === 'supergroup' && 
               msg.chat.id.toString() === this.config.chatId.toString() &&
               msg.is_topic_message;
    }

    async handleTelegramMessage(msg) {
        try {
            // Skip commands
            if (msg.text && msg.text.startsWith('/')) {
                return;
            }

            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            // Send typing indicator
            await this.sendTypingIndicator(whatsappJid);

            // Forward message to WhatsApp
            await this.forwardTelegramMessageToWhatsApp(msg, whatsappJid);
            
            // Send confirmation (v3 feature)
            await this.sendMessageConfirmation(msg);

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await this.sendErrorConfirmation(msg);
        }
    }

    async sendTypingIndicator(whatsappJid) {
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

    async sendMessageConfirmation(msg) {
        try {
            switch (this.config.confirmationType) {
                case 'emoji':
                    await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '👍' }]);
                    break;
                case 'text':
                    const confirmMsg = await this.telegramBot.sendMessage(msg.chat.id, '✅ Sent', {
                        message_thread_id: msg.message_thread_id,
                        disable_notification: true
                    });
                    // Auto-delete after 10 seconds
                    setTimeout(async () => {
                        try {
                            await this.telegramBot.deleteMessage(msg.chat.id, confirmMsg.message_id);
                        } catch (error) {
                            // Ignore deletion errors
                        }
                    }, 10000);
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
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
        } catch (error) {
            // Ignore reaction errors
        }
    }

    async forwardTelegramMessageToWhatsApp(msg, whatsappJid) {
        try {
            if (msg.text) {
                await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            } else if (msg.photo) {
                await this.handleTelegramPhoto(msg, whatsappJid);
            } else if (msg.video) {
                await this.handleTelegramVideo(msg, whatsappJid);
            } else if (msg.animation) {
                await this.handleTelegramAnimation(msg, whatsappJid);
            } else if (msg.audio) {
                await this.handleTelegramAudio(msg, whatsappJid);
            } else if (msg.voice) {
                await this.handleTelegramVoice(msg, whatsappJid);
            } else if (msg.document) {
                await this.handleTelegramDocument(msg, whatsappJid);
            } else if (msg.sticker) {
                await this.handleTelegramSticker(msg, whatsappJid);
            } else if (msg.location) {
                await this.handleTelegramLocation(msg, whatsappJid);
            } else if (msg.contact) {
                await this.handleTelegramContact(msg, whatsappJid);
            }
        } catch (error) {
            logger.error('❌ Failed to forward message to WhatsApp:', error);
            throw error;
        }
    }

    async handleTelegramPhoto(msg, whatsappJid) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const buffer = await this.downloadTelegramFile(fileId);
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            image: buffer,
            caption: msg.caption || '',
            viewOnce: msg.has_media_spoiler && this.config.spoilerViewOnce
        });
    }

    async handleTelegramVideo(msg, whatsappJid) {
        const buffer = await this.downloadTelegramFile(msg.video.file_id);
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            video: buffer,
            caption: msg.caption || '',
            viewOnce: msg.has_media_spoiler && this.config.spoilerViewOnce,
            gifPlayback: false
        });
    }

    async handleTelegramAnimation(msg, whatsappJid) {
        const buffer = await this.downloadTelegramFile(msg.animation.file_id);
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            video: buffer,
            caption: msg.caption || '',
            gifPlayback: true
        });
    }

    async handleTelegramAudio(msg, whatsappJid) {
        const buffer = await this.downloadTelegramFile(msg.audio.file_id);
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            audio: buffer,
            mimetype: 'audio/mp4',
            ptt: false,
            fileName: msg.audio.file_name || 'audio.mp3'
        });
    }

    async handleTelegramVoice(msg, whatsappJid) {
        const buffer = await this.downloadTelegramFile(msg.voice.file_id);
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            audio: buffer,
            ptt: true,
            mimetype: 'audio/ogg; codecs=opus'
        });
    }

    async handleTelegramDocument(msg, whatsappJid) {
        const buffer = await this.downloadTelegramFile(msg.document.file_id);
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            document: buffer,
            fileName: msg.document.file_name || 'document',
            mimetype: msg.document.mime_type || 'application/octet-stream',
            caption: msg.caption || ''
        });
    }

    async handleTelegramSticker(msg, whatsappJid) {
        const buffer = await this.downloadTelegramFile(msg.sticker.file_id);
        
        // Convert to WebP if needed
        let stickerBuffer = buffer;
        if (!msg.sticker.is_animated && !msg.sticker.is_video) {
            try {
                stickerBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp()
                    .toBuffer();
            } catch (error) {
                logger.debug('Could not convert sticker:', error);
            }
        }
        
        await this.whatsappBot.sendMessage(whatsappJid, {
            sticker: stickerBuffer
        });
    }

    async handleTelegramLocation(msg, whatsappJid) {
        await this.whatsappBot.sendMessage(whatsappJid, {
            location: {
                degreesLatitude: msg.location.latitude,
                degreesLongitude: msg.location.longitude
            }
        });
    }

    async handleTelegramContact(msg, whatsappJid) {
        const firstName = msg.contact.first_name || '';
        const lastName = msg.contact.last_name || '';
        const phoneNumber = msg.contact.phone_number || '';
        const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

        const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

        await this.whatsappBot.sendMessage(whatsappJid, {
            contacts: {
                displayName: displayName,
                contacts: [{ vcard: vcard }]
            }
        });
    }

    async downloadTelegramFile(fileId) {
        const fileLink = await this.telegramBot.getFileLink(fileId);
        const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    }

    // WhatsApp to Telegram sync
    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !this.config.enabled) return;

        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            // Update user mapping
            await this.updateUserMapping(participant, whatsappMsg);
            
            // Get or create topic
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            if (!topicId) return;

            // Handle different message types
            const message = whatsappMsg.message;
            let sentMessageId = null;
            
            if (message?.imageMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
            } else if (message?.videoMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
            } else if (message?.audioMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
            } else if (message?.documentMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
            } else if (message?.stickerMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
            } else if (message?.locationMessage) {
                sentMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
            } else if (message?.contactMessage || message?.contactsArrayMessage) {
                sentMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
            } else if (text) {
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

            this.stats.messagesForwarded++;

        } catch (error) {
            logger.error('❌ Error syncing WhatsApp message:', error);
            this.stats.errors++;
        }
    }

    async updateUserMapping(participant, whatsappMsg) {
        try {
            if (this.userMappings.has(participant)) {
                const existing = this.userMappings.get(participant);
                existing.messageCount = (existing.messageCount || 0) + 1;
                existing.lastSeen = new Date();
                
                if (whatsappMsg.pushName && !existing.name) {
                    existing.name = whatsappMsg.pushName;
                }
                return;
            }

            let userName = null;
            let userPhone = participant.split('@')[0];
            
            if (whatsappMsg.pushName) {
                userName = whatsappMsg.pushName;
            }

            this.userMappings.set(participant, {
                name: userName,
                phone: userPhone,
                firstSeen: new Date(),
                lastSeen: new Date(),
                messageCount: 1
            });

            logger.debug(`👤 Created user mapping: ${userName || userPhone}`);
        } catch (error) {
            logger.debug('Could not update user mapping:', error);
        }
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        try {
            if (this.chatMappings.has(chatJid)) {
                return this.chatMappings.get(chatJid);
            }

            if (!this.config.chatId || this.config.chatId.toString().includes('YOUR_CHAT_ID_HERE')) {
                logger.error('❌ Telegram chat ID not configured properly');
                return null;
            }

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
                    topicName = groupMeta.subject || 'Group Chat';
                } catch (error) {
                    topicName = 'Group Chat';
                }
                iconColor = 0x6FB9F0; // Blue
            } else {
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                const phone = participant.split('@')[0];
                
                topicName = userInfo?.name || phone;
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(this.config.chatId, topicName, {
                icon_color: iconColor
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            this.stats.topicsCreated++;
            
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message for private chats
            if (!isStatus && !isCall && !isGroup) {
                await this.sendWelcomeMessage(topic.message_thread_id, chatJid);
            }
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, jid) {
        try {
            const userInfo = this.userMappings.get(jid);
            const phone = jid.split('@')[0];
            
            let welcomeText = `👤 **Contact Information**\n\n`;
            welcomeText += `📝 **Name:** ${userInfo?.name || 'Not available'}\n`;
            welcomeText += `📱 **Phone:** +${phone}\n`;
            welcomeText += `🆔 **WhatsApp ID:** \`${jid}\`\n`;
            welcomeText += `📅 **First Contact:** ${new Date().toLocaleDateString()}\n\n`;
            welcomeText += `💬 Messages with this contact will appear here`;

            const sentMessage = await this.telegramBot.sendMessage(this.config.chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            // Pin the welcome message
            try {
                await this.telegramBot.pinChatMessage(this.config.chatId, sentMessage.message_id);
            } catch (error) {
                logger.debug('Could not pin welcome message:', error);
            }

            // Send profile picture if available
            await this.sendProfilePicture(topicId, jid);

        } catch (error) {
            logger.error('❌ Failed to send welcome message:', error);
        }
    }

    async sendProfilePicture(topicId, jid) {
        try {
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            
            if (profilePicUrl) {
                await this.telegramBot.sendPhoto(this.config.chatId, profilePicUrl, {
                    message_thread_id: topicId,
                    caption: '📸 Profile Picture'
                });
                
                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error);
        }
    }

    async sendSimpleMessage(topicId, text, sender, participant, whatsappMsg) {
        try {
            if (!topicId) return null;
            
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

            // Handle view once messages (v1 spoiler feature)
            if (whatsappMsg.message?.viewOnceMessage || whatsappMsg.message?.viewOnceMessageV2) {
                messageText = `🔒 **View Once Message**\n\n||${messageText}||`;
            }

            // Handle ephemeral messages
            if (whatsappMsg.message?.ephemeralMessage) {
                messageText = `⏰ **Ephemeral Message**\n\n${messageText}`;
            }

            // Add revoke button for own messages
            if (whatsappMsg.key.fromMe) {
                replyMarkup = {
                    inline_keyboard: [[{
                        text: '🗑️ Revoke',
                        callback_data: `revoke_${whatsappMsg.key.id}_${sender}`
                    }]]
                };
            }

            const sentMessage = await this.telegramBot.sendMessage(this.config.chatId, messageText, {
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

            // Handle view once media (v1 spoiler feature)
            const isViewOnce = mediaMessage.viewOnce;
            if (isViewOnce && this.config.spoilerViewOnce) {
                caption = `🔒 **View Once Media**\n\n${caption}`;
            }

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to Telegram based on media type
            let sentMessage;
            const options = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown',
                has_spoiler: isViewOnce && this.config.spoilerViewOnce
            };

            switch (mediaType) {
                case 'image':
                    sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, filePath, options);
                    break;
                    
                case 'video':
                    if (mediaMessage.gifPlayback) {
                        sentMessage = await this.telegramBot.sendAnimation(this.config.chatId, filePath, options);
                    } else {
                        sentMessage = await this.telegramBot.sendVideo(this.config.chatId, filePath, options);
                    }
                    break;
                    
                case 'audio':
                    if (mediaMessage.ptt) {
                        sentMessage = await this.telegramBot.sendVoice(this.config.chatId, filePath, options);
                    } else {
                        sentMessage = await this.telegramBot.sendAudio(this.config.chatId, filePath, options);
                    }
                    break;
                    
                case 'document':
                    sentMessage = await this.telegramBot.sendDocument(this.config.chatId, filePath, options);
                    break;
                    
                case 'sticker':
                    try {
                        sentMessage = await this.telegramBot.sendSticker(this.config.chatId, filePath, {
                            message_thread_id: topicId
                        });
                    } catch (stickerError) {
                        // Fallback: send as photo
                        sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, filePath, {
                            message_thread_id: topicId,
                            caption: caption || 'Sticker',
                            parse_mode: 'Markdown'
                        });
                    }
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            this.stats.mediaForwarded++;
            return sentMessage?.message_id;
        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
            return null;
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const locationMessage = whatsappMsg.message.locationMessage;
            
            // Add sender info for group messages
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            let caption = '';
            
            if (sender.endsWith('@g.us') && participant !== sender) {
                const userInfo = this.userMappings.get(participant);
                const name = userInfo?.name || participant.split('@')[0];
                caption = `👤 **${name}** shared a location`;
            }

            const sentMessage = await this.telegramBot.sendLocation(this.config.chatId, 
                locationMessage.degreesLatitude, 
                locationMessage.degreesLongitude, {
                    message_thread_id: topicId
                });

            if (caption) {
                await this.telegramBot.sendMessage(this.config.chatId, caption, {
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
            const contactMessage = whatsappMsg.message.contactMessage;
            const vcard = contactMessage.vcard;
            const displayName = contactMessage.displayName || 'Unknown Contact';

            // Add sender info for group messages
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            let caption = `📇 Contact: ${displayName}`;
            
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
            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
            return null;
        }
    }

    async handleCallNotification(callEvent) {
        try {
            if (!this.config.chatId) return;

            const callId = `${callEvent.from}_${callEvent.id}_${callEvent.status}`;
            
            if (this.callHistory.has(callId)) {
                return;
            }
            
            this.callHistory.set(callId, Date.now());
            
            // Clean old call history
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            for (const [id, timestamp] of this.callHistory.entries()) {
                if (timestamp < oneHourAgo) {
                    this.callHistory.delete(id);
                }
            }

            const callTopicId = await this.getOrCreateTopic('call@broadcast', {
                key: { participant: callEvent.from },
                pushName: callEvent.from.split('@')[0]
            });

            if (!callTopicId) return;

            const userInfo = this.userMappings.get(callEvent.from);
            const callerName = userInfo?.name || callEvent.from.split('@')[0];
            
            let statusEmoji = '📞';
            let statusText = callEvent.status;
            
            switch (callEvent.status) {
                case 'offer':
                    statusEmoji = '📞';
                    statusText = 'Incoming Call';
                    break;
                case 'accept':
                    statusEmoji = '✅';
                    statusText = 'Call Accepted';
                    break;
                case 'reject':
                    statusEmoji = '❌';
                    statusText = 'Call Rejected';
                    break;
                case 'timeout':
                    statusEmoji = '⏰';
                    statusText = 'Call Missed';
                    break;
            }

            const callText = `${statusEmoji} **${statusText}**\n\n` +
                           `👤 From: **${callerName}** (+${callEvent.from.split('@')[0]})\n` +
                           `📅 Time: ${new Date().toLocaleString()}\n` +
                           `🆔 Call ID: \`${callEvent.id}\``;

            await this.telegramBot.sendMessage(this.config.chatId, callText, {
                message_thread_id: callTopicId,
                parse_mode: 'Markdown'
            });

            this.stats.callsLogged++;
        } catch (error) {
            logger.error('❌ Failed to handle call notification:', error);
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

    async sendStartupMessage() {
        try {
            if (this.config.logChannel && !this.config.logChannel.includes('YOUR_LOG_CHANNEL_ID_HERE')) {
                await this.telegramBot.sendMessage(this.config.logChannel, 
                    `🤖 **Telegram Bridge Started**\n\n` +
                    `✅ Bot: Connected\n` +
                    `📱 WhatsApp: Ready\n` +
                    `🔗 Bridge: Active\n` +
                    `🚀 Ready to bridge messages!\n\n` +
                    `⏰ ${new Date().toLocaleString()}`, {
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            logger.debug('Could not send startup message:', error);
        }
    }

    async syncWhatsAppConnection() {
        try {
            if (!this.telegramBot) return;

            if (this.config.logChannel && !this.config.logChannel.includes('YOUR_LOG_CHANNEL_ID_HERE')) {
                await this.telegramBot.sendMessage(this.config.logChannel, 
                    `🤖 **WhatsApp Bot Connected**\n\n` +
                    `✅ Bot: Connected\n` +
                    `📱 WhatsApp: Connected\n` +
                    `🔗 Telegram Bridge: Active\n` +
                    `🚀 Ready to bridge messages!\n\n` +
                    `⏰ ${new Date().toLocaleString()}`, {
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            logger.debug('Could not send connection sync message:', error);
        }
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = this.config.logChannel;
        if (!logChannel || logChannel.includes('YOUR_LOG_CHANNEL_ID_HERE')) {
            logger.debug('Telegram log channel not configured');
            return;
        }

        try {
            const logMessage = `🤖 **${title}**\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

    // Utility methods
    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) return jid;
        }
        return null;
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               '';
    }

    isProperlyConfigured() {
        return this.config.botToken && 
               !this.config.botToken.includes('YOUR_BOT_TOKEN_HERE') &&
               this.config.chatId && 
               !this.config.chatId.toString().includes('YOUR_CHAT_ID_HERE');
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
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
