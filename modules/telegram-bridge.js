const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
const sharp = require('sharp');
const NodeCache = require('node-cache');

const logger = require('../core/logger');
const config = require('../config');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.bot = null;
        this.groupId = null;
        this.topicCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache
        this.userCache = new NodeCache({ stdTTL: 1800 }); // 30 minutes cache
        this.mediaPath = path.join(__dirname, '../media');
        this.topics = {
            callLogs: null,
            statusUpdates: null,
            users: new Map()
        };
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.callTracker = new Map(); // Track processed calls with timestamps
        this.threadToUserMap = new Map(); // Map thread IDs to user JIDs
    }

    async initialize() {
        try {
            const token = config.get('telegram.botToken');
            const groupId = config.get('telegram.groupId');

            if (!token || !groupId) {
                logger.warn('⚠️ Telegram bridge not configured properly');
                return;
            }

            this.bot = new TelegramBot(token, { polling: true });
            this.groupId = groupId;

            await fs.ensureDir(this.mediaPath);
            await this.setupEventHandlers();
            await this.initializeTopics();

            logger.info('✅ Telegram bridge initialized successfully');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupEventHandlers() {
        // Handle incoming Telegram messages
        this.bot.on('message', async (msg) => {
            try {
                await this.handleTelegramMessage(msg);
            } catch (error) {
                logger.error('Error handling Telegram message:', error);
            }
        });

        // Handle callback queries (inline buttons)
        this.bot.on('callback_query', async (query) => {
            try {
                await this.handleCallbackQuery(query);
            } catch (error) {
                logger.error('Error handling callback query:', error);
            }
        });

        // Handle errors
        this.bot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        // Handle polling errors
        this.bot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
        });
    }

    setupWhatsAppHandlers() {
        if (!this.whatsappBot.sock) return;

        // Handle call events
        this.whatsappBot.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                await this.handleWhatsAppCall(call);
            }
        });

        // Handle contacts update for profile pictures
        this.whatsappBot.sock.ev.on('contacts.update', async (contacts) => {
            for (const contact of contacts) {
                if (contact.imgUrl) {
                    await this.handleProfilePictureUpdate(contact);
                }
            }
        });
    }

    async initializeTopics() {
        try {
            // Create call logs topic
            this.topics.callLogs = await this.createOrGetTopic('📞 Call Logs');

            // Create status updates topic
            this.topics.statusUpdates = await this.createOrGetTopic('📱 Status Updates');

            logger.info('✅ Telegram topics initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize topics:', error);
        }
    }

    async createOrGetTopic(name) {
        try {
            // Try to find existing topic
            const existingTopic = this.topicCache.get(name);
            if (existingTopic) {
                return existingTopic;
            }

            // Create new topic
            const topic = await this.bot.createForumTopic(this.groupId, name);
            
            const topicData = {
                id: topic.message_thread_id,
                name: name
            };

            this.topicCache.set(name, topicData);
            return topicData;
        } catch (error) {
            logger.error(`Failed to create topic ${name}:`, error);
            return null;
        }
    }

    async getUserTopic(jid, pushName, notify) {
        const userId = jid.split('@')[0];
        const cacheKey = `user_${userId}`;
        
        // Check cache first
        let userTopic = this.topicCache.get(cacheKey);
        if (userTopic) {
            return userTopic;
        }

        try {
            // Get user info
            const userInfo = await this.getUserInfo(jid, pushName, notify);
            const topicName = `${userInfo.name}`;

            // Create topic
            const topic = await this.bot.createForumTopic(this.groupId, topicName);
            
            userTopic = {
                id: topic.message_thread_id,
                name: topicName,
                jid: jid,
                userId: userId
            };

            // Store mappings
            this.topicCache.set(cacheKey, userTopic);
            this.topics.users.set(userId, userTopic);
            this.threadToUserMap.set(topic.message_thread_id, jid);

            // Create user info message
            const userInfoMsg = await this.createUserInfoMessage(userInfo);
            const infoMsg = await this.bot.sendMessage(this.groupId, userInfoMsg, {
                message_thread_id: topic.message_thread_id,
                parse_mode: 'Markdown'
            });
            
            // Pin user info
            try {
                await this.bot.pinChatMessage(this.groupId, infoMsg.message_id);
            } catch (pinError) {
                logger.warn('Could not pin message:', pinError.message);
            }

            // Send profile picture if available
            await this.sendProfilePicture(jid, topic.message_thread_id);

            logger.info(`✅ Created topic for user: ${userInfo.name} (${userId})`);
            return userTopic;
        } catch (error) {
            logger.error(`Failed to create user topic for ${jid}:`, error);
            return null;
        }
    }

    async getUserInfo(jid, pushName, notify) {
        const userId = jid.split('@')[0];
        
        try {
            const profilePic = await this.getProfilePictureUrl(jid);
            
            return {
                jid: jid,
                userId: userId,
                name: pushName || notify || userId,
                number: userId,
                profilePic: profilePic,
                lastSeen: new Date().toISOString()
            };
        } catch (error) {
            logger.error(`Error getting user info for ${jid}:`, error);
            return {
                jid: jid,
                userId: userId,
                name: pushName || notify || userId,
                number: userId,
                profilePic: null,
                lastSeen: new Date().toISOString()
            };
        }
    }

    async getProfilePictureUrl(jid) {
        try {
            if (!this.whatsappBot.sock) return null;
            const profilePic = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            return profilePic;
        } catch (error) {
            return null;
        }
    }

    createUserInfoMessage(userInfo) {
        return `👤 **${userInfo.name}**\n` +
               `📞 **+${userInfo.number}**\n` +
               `🆔 **${userInfo.jid}**\n\n` +
               `💬 Reply here to send messages`;
    }

    async sendProfilePicture(jid, threadId) {
        try {
            const profilePicUrl = await this.getProfilePictureUrl(jid);
            if (!profilePicUrl) return;

            // Download and send profile picture
            const response = await axios.get(profilePicUrl, { 
                responseType: 'arraybuffer',
                timeout: 10000
            });
            const buffer = Buffer.from(response.data);

            await this.bot.sendPhoto(this.groupId, buffer, {
                message_thread_id: threadId,
                caption: 'Profile Picture'
            });
        } catch (error) {
            logger.error(`Failed to send profile picture for ${jid}:`, error);
        }
    }

    async syncMessage(whatsappMsg, text) {
        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const isGroup = sender.endsWith('@g.us');
            const isFromMe = whatsappMsg.key.fromMe;

            // Skip status messages (handled separately)
            if (sender === 'status@broadcast') {
                return this.handleWhatsAppStatus(whatsappMsg);
            }

            // Get user topic
            const pushName = whatsappMsg.pushName;
            const notify = whatsappMsg.verifiedBizName || whatsappMsg.pushName;
            const userJid = isGroup ? participant : sender;
            
            const userTopic = await this.getUserTopic(userJid, pushName, notify);
            if (!userTopic) return;

            // Format message with sender info if needed
            let messageText = text;
            if (isFromMe) {
                messageText = `📤 **You:** ${text || ''}`;
            } else {
                messageText = `📥 **${pushName || userJid.split('@')[0]}:** ${text || ''}`;
            }

            // Send text message if exists
            if (messageText && messageText.trim()) {
                await this.bot.sendMessage(this.groupId, messageText, {
                    message_thread_id: userTopic.id,
                    parse_mode: 'Markdown'
                });
            }

            // Handle media
            await this.handleWhatsAppMedia(whatsappMsg, userTopic.id, isFromMe);

        } catch (error) {
            logger.error('Error syncing message to Telegram:', error);
        }
    }

    async handleWhatsAppMedia(msg, threadId, isFromMe = false) {
        try {
            let mediaBuffer = null;
            let fileName = null;
            let caption = null;
            let mediaType = null;

            const senderPrefix = isFromMe ? '📤 **You:** ' : '📥 ';

            if (msg.message?.imageMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'image.jpg';
                caption = msg.message.imageMessage.caption;
                mediaType = 'image';
            } else if (msg.message?.videoMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'video.mp4';
                caption = msg.message.videoMessage.caption;
                mediaType = 'video';
            } else if (msg.message?.audioMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'audio.ogg';
                mediaType = 'audio';
            } else if (msg.message?.documentMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = msg.message.documentMessage.fileName || 'document';
                mediaType = 'document';
            } else if (msg.message?.stickerMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'sticker.webp';
                mediaType = 'sticker';
            }

            if (mediaBuffer && mediaType) {
                const finalCaption = caption ? `${senderPrefix}${caption}` : senderPrefix.trim();
                await this.sendMediaToTelegram(threadId, mediaBuffer, fileName, finalCaption, mediaType);
            }
        } catch (error) {
            logger.error('Error handling WhatsApp media:', error);
        }
    }

    async sendMediaToTelegram(threadId, buffer, fileName, caption = null, mediaType) {
        try {
            const options = {
                message_thread_id: threadId,
                caption: caption || undefined
            };

            switch (mediaType) {
                case 'image':
                    await this.bot.sendPhoto(this.groupId, buffer, options);
                    break;
                case 'video':
                    await this.bot.sendVideo(this.groupId, buffer, options);
                    break;
                case 'audio':
                    await this.bot.sendAudio(this.groupId, buffer, options);
                    break;
                case 'sticker':
                    // Convert webp to png for better compatibility
                    try {
                        const pngBuffer = await sharp(buffer).png().toBuffer();
                        await this.bot.sendPhoto(this.groupId, pngBuffer, options);
                    } catch (conversionError) {
                        // Fallback to document if conversion fails
                        options.filename = fileName;
                        await this.bot.sendDocument(this.groupId, buffer, options);
                    }
                    break;
                default:
                    options.filename = fileName;
                    await this.bot.sendDocument(this.groupId, buffer, options);
            }
        } catch (error) {
            logger.error('Error sending media to Telegram:', error);
        }
    }

    async handleTelegramMessage(msg) {
        try {
            // Skip non-group messages
            if (msg.chat.id.toString() !== this.groupId.toString()) return;

            // Skip messages without thread ID (not in topics)
            if (!msg.message_thread_id) return;

            // Skip bot messages
            if (msg.from.is_bot) return;

            logger.info(`📨 Telegram message received in thread: ${msg.message_thread_id}`);

            // Find corresponding WhatsApp user using thread mapping
            const userJid = this.threadToUserMap.get(msg.message_thread_id);
            
            if (userJid) {
                logger.info(`🔄 Forwarding to WhatsApp user: ${userJid}`);
                // Send to WhatsApp
                await this.sendToWhatsApp(userJid, msg);
            } else if (msg.message_thread_id === this.topics.statusUpdates?.id) {
                // Handle status reply
                await this.handleStatusReply(msg);
            } else {
                logger.warn(`❓ No user found for thread ID: ${msg.message_thread_id}`);
                // Try to find user topic by searching through topics
                const userTopic = this.findUserTopicByThreadId(msg.message_thread_id);
                if (userTopic) {
                    logger.info(`🔄 Found user topic, forwarding to: ${userTopic.jid}`);
                    await this.sendToWhatsApp(userTopic.jid, msg);
                }
            }

        } catch (error) {
            logger.error('Error handling Telegram message:', error);
        }
    }

    findUserTopicByThreadId(threadId) {
        for (const [userId, topic] of this.topics.users) {
            if (topic.id === threadId) {
                return topic;
            }
        }
        return null;
    }

    async sendToWhatsApp(jid, telegramMsg) {
        try {
            let content = {};

            if (telegramMsg.text) {
                content = { text: telegramMsg.text };
            } else if (telegramMsg.photo) {
                const photo = telegramMsg.photo[telegramMsg.photo.length - 1];
                const fileBuffer = await this.downloadTelegramFile(photo.file_id);
                content = {
                    image: fileBuffer,
                    caption: telegramMsg.caption || undefined
                };
            } else if (telegramMsg.video) {
                const fileBuffer = await this.downloadTelegramFile(telegramMsg.video.file_id);
                content = {
                    video: fileBuffer,
                    caption: telegramMsg.caption || undefined
                };
            } else if (telegramMsg.audio || telegramMsg.voice) {
                const audio = telegramMsg.audio || telegramMsg.voice;
                const fileBuffer = await this.downloadTelegramFile(audio.file_id);
                content = { audio: fileBuffer };
            } else if (telegramMsg.document) {
                const fileBuffer = await this.downloadTelegramFile(telegramMsg.document.file_id);
                content = {
                    document: fileBuffer,
                    fileName: telegramMsg.document.file_name || 'document',
                    caption: telegramMsg.caption || undefined
                };
            } else if (telegramMsg.sticker) {
                const fileBuffer = await this.downloadTelegramFile(telegramMsg.sticker.file_id);
                content = { sticker: fileBuffer };
            }

            if (Object.keys(content).length > 0) {
                // Ensure WhatsApp is connected before sending
                if (!this.whatsappBot.sock || !this.whatsappBot.sock.user) {
                    throw new Error('WhatsApp not connected');
                }

                await this.whatsappBot.sendMessage(jid, content);
                logger.info(`✅ Message sent to WhatsApp: ${jid}`);
                
                // Send confirmation to Telegram
                await this.bot.sendMessage(this.groupId, 
                    '✅ Message sent successfully', {
                    message_thread_id: telegramMsg.message_thread_id
                });
            }

        } catch (error) {
            logger.error('Error sending message to WhatsApp:', error);
            
            // Send error message back to Telegram
            await this.bot.sendMessage(this.groupId, 
                `❌ Failed to send message: ${error.message}`, {
                message_thread_id: telegramMsg.message_thread_id
            });
        }
    }

    async downloadTelegramFile(fileId) {
        try {
            const fileInfo = await this.bot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${fileInfo.file_path}`;
            
            const response = await axios.get(fileUrl, { 
                responseType: 'arraybuffer',
                timeout: 30000
            });
            return Buffer.from(response.data);
        } catch (error) {
            logger.error('Error downloading Telegram file:', error);
            throw error;
        }
    }

    async handleWhatsAppCall(call) {
        try {
            if (!this.topics.callLogs) return;

            const caller = call.from.split('@')[0];
            const callId = `${caller}_${call.id}`;
            const now = Date.now();
            
            // Check if we already processed this call recently (within 5 seconds)
            const lastProcessed = this.callTracker.get(callId);
            if (lastProcessed && (now - lastProcessed) < 5000) {
                return; // Skip duplicate
            }
            
            this.callTracker.set(callId, now);
            
            // Clean up old call tracking entries (older than 1 hour)
            for (const [id, timestamp] of this.callTracker.entries()) {
                if (now - timestamp > 3600000) { // 1 hour
                    this.callTracker.delete(id);
                }
            }

            const callInfo = this.formatCallInfo(call);
            await this.bot.sendMessage(this.groupId, callInfo, {
                message_thread_id: this.topics.callLogs.id,
                parse_mode: 'Markdown'
            });

            logger.info(`📞 Call logged: ${call.from} - ${call.status}`);
        } catch (error) {
            logger.error('Error handling WhatsApp call:', error);
        }
    }

    formatCallInfo(call) {
        const caller = call.from.split('@')[0];
        const callType = call.isVideo ? '📹' : '📞';
        const timestamp = new Date().toLocaleString();
        
        let status;
        switch (call.status) {
            case 'offer':
                status = '📞 **Incoming Call**';
                break;
            case 'accept':
                status = '✅ **Call Accepted**';
                break;
            case 'reject':
                status = '❌ **Call Rejected**';
                break;
            case 'timeout':
                status = '⏰ **Missed Call**';
                break;
            default:
                status = `📞 **${call.status}**`;
        }

        return `${callType} ${status}\n` +
               `👤 **From:** +${caller}\n` +
               `🕐 **Time:** ${timestamp}`;
    }

    async handleWhatsAppStatus(msg) {
        try {
            if (!this.topics.statusUpdates) return;

            const sender = msg.key.participant?.split('@')[0] || 'Unknown';
            const text = msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

            let statusText = `📱 **Status from +${sender}**`;
            if (text) {
                statusText += `\n\n${text}`;
            }

            const sentMsg = await this.bot.sendMessage(this.groupId, statusText, {
                message_thread_id: this.topics.statusUpdates.id,
                parse_mode: 'Markdown'
            });

            // Store status message mapping for replies
            this.userCache.set(`status_${sentMsg.message_id}`, {
                whatsappMsgKey: msg.key,
                sender: msg.key.participant
            });

            // Handle status media
            await this.handleWhatsAppMedia(msg, this.topics.statusUpdates.id);

            logger.info(`📱 Status update logged from: ${msg.key.participant}`);
        } catch (error) {
            logger.error('Error handling WhatsApp status:', error);
        }
    }

    async handleStatusReply(telegramMsg) {
        try {
            if (!telegramMsg.reply_to_message) return;

            const statusData = this.userCache.get(`status_${telegramMsg.reply_to_message.message_id}`);
            if (!statusData) {
                await this.bot.sendMessage(this.groupId, 
                    '❌ Cannot find original status message', {
                    message_thread_id: telegramMsg.message_thread_id
                });
                return;
            }

            // Send reply to WhatsApp status
            await this.whatsappBot.sendMessage(statusData.sender, {
                text: telegramMsg.text
            });

            await this.bot.sendMessage(this.groupId, 
                '✅ Reply sent to WhatsApp status', {
                message_thread_id: telegramMsg.message_thread_id
            });

        } catch (error) {
            logger.error('Error handling status reply:', error);
        }
    }

    async handleProfilePictureUpdate(contact) {
        try {
            const userTopic = this.topics.users.get(contact.id.split('@')[0]);
            if (!userTopic) return;

            await this.bot.sendMessage(this.groupId, 
                '📸 Profile picture updated', {
                message_thread_id: userTopic.id
            });

            // Send new profile picture
            await this.sendProfilePicture(contact.id, userTopic.id);

        } catch (error) {
            logger.error('Error handling profile picture update:', error);
        }
    }

    async handleCallbackQuery(query) {
        try {
            await this.bot.answerCallbackQuery(query.id);
        } catch (error) {
            logger.error('Error handling callback query:', error);
        }
    }

    async logToTelegram(title, message) {
        try {
            const logMessage = `🔔 **${title}**\n\n${message}`;
            await this.bot.sendMessage(this.groupId, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('Error logging to Telegram:', error);
        }
    }

    async syncWhatsAppConnection() {
        try {
            if (this.whatsappBot.sock?.user) {
                await this.logToTelegram('🔗 WhatsApp Connected', 
                    `Bot connected as: ${this.whatsappBot.sock.user.name || 'Unknown'}\n` +
                    `Number: ${this.whatsappBot.sock.user.id.split(':')[0]}`);
            }
        } catch (error) {
            logger.error('Error syncing WhatsApp connection:', error);
        }
    }

    async shutdown() {
        try {
            if (this.bot) {
                await this.bot.stopPolling();
                logger.info('✅ Telegram bridge shutdown complete');
            }
        } catch (error) {
            logger.error('Error shutting down Telegram bridge:', error);
        }
    }
}

module.exports = TelegramBridge;
