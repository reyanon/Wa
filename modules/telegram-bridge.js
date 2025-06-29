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

        // Setup WhatsApp event handlers
        if (this.whatsappBot.sock) {
            this.setupWhatsAppHandlers();
        }
    }

    setupWhatsAppHandlers() {
        // Handle call events
        this.whatsappBot.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                await this.handleWhatsAppCall(call);
            }
        });

        // Handle status updates
        this.whatsappBot.sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast') {
                    await this.handleWhatsAppStatus(msg);
                }
            }
        });

        // Handle profile picture updates
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
            this.topics.callLogs = await this.createOrGetTopic('📞 Call Logs', 
                '📞 All WhatsApp call logs will appear here');

            // Create status updates topic
            this.topics.statusUpdates = await this.createOrGetTopic('📱 Status Updates', 
                '📱 WhatsApp status updates will appear here\n\n💡 Reply to any status to respond on WhatsApp');

            logger.info('✅ Telegram topics initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize topics:', error);
        }
    }

    async createOrGetTopic(name, description) {
        try {
            // Try to find existing topic
            const existingTopic = this.topicCache.get(name);
            if (existingTopic) {
                return existingTopic;
            }

            // Create new topic
            const topic = await this.bot.createForumTopic(this.groupId, name);
            
            // Pin description message
            const descMsg = await this.bot.sendMessage(this.groupId, description, {
                message_thread_id: topic.message_thread_id,
                parse_mode: 'Markdown'
            });
            
            await this.bot.pinChatMessage(this.groupId, descMsg.message_id);

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
            const topicName = `👤 ${userInfo.name}`;

            // Create topic
            const topic = await this.bot.createForumTopic(this.groupId, topicName);
            
            // Create user info message
            const userInfoMsg = await this.createUserInfoMessage(userInfo);
            const infoMsg = await this.bot.sendMessage(this.groupId, userInfoMsg, {
                message_thread_id: topic.message_thread_id,
                parse_mode: 'Markdown'
            });
            
            // Pin user info
            await this.bot.pinChatMessage(this.groupId, infoMsg.message_id);

            // Send profile picture if available
            await this.sendProfilePicture(jid, topic.message_thread_id);

            userTopic = {
                id: topic.message_thread_id,
                name: topicName,
                jid: jid,
                userId: userId
            };

            this.topicCache.set(cacheKey, userTopic);
            this.topics.users.set(userId, userTopic);

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
            // Try to get contact info from WhatsApp
            const contact = await this.whatsappBot.sock.onWhatsApp(jid);
            const profilePic = await this.getProfilePictureUrl(jid);
            
            return {
                jid: jid,
                userId: userId,
                name: pushName || notify || contact[0]?.notify || userId,
                number: userId,
                profilePic: profilePic,
                isWhatsAppUser: contact[0]?.exists || false,
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
                isWhatsAppUser: true,
                lastSeen: new Date().toISOString()
            };
        }
    }

    async getProfilePictureUrl(jid) {
        try {
            const profilePic = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            return profilePic;
        } catch (error) {
            return null;
        }
    }

    createUserInfoMessage(userInfo) {
        return `👤 **User Information**\n\n` +
               `📱 **Name:** ${userInfo.name}\n` +
               `📞 **Number:** +${userInfo.number}\n` +
               `🆔 **WhatsApp ID:** ${userInfo.jid}\n` +
               `✅ **WhatsApp User:** ${userInfo.isWhatsAppUser ? 'Yes' : 'No'}\n` +
               `🕐 **Topic Created:** ${new Date().toLocaleString()}\n\n` +
               `💬 **All messages with this user will appear in this topic**\n` +
               `📤 **Reply here to send messages to WhatsApp**`;
    }

    async sendProfilePicture(jid, threadId) {
        try {
            const profilePicUrl = await this.getProfilePictureUrl(jid);
            if (!profilePicUrl) return;

            // Download and send profile picture
            const response = await axios.get(profilePicUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            await this.bot.sendPhoto(this.groupId, buffer, {
                message_thread_id: threadId,
                caption: '📸 Profile Picture'
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
            if (sender === 'status@broadcast') return;

            // Get user topic
            const pushName = whatsappMsg.pushName;
            const notify = whatsappMsg.verifiedBizName || whatsappMsg.pushName;
            const userJid = isGroup ? participant : sender;
            
            const userTopic = await this.getUserTopic(userJid, pushName, notify);
            if (!userTopic) return;

            // Format message
            const messageText = await this.formatWhatsAppMessage(whatsappMsg, text, isGroup, isFromMe);
            
            // Send to Telegram
            await this.sendToTelegram(userTopic.id, messageText, whatsappMsg);

        } catch (error) {
            logger.error('Error syncing message to Telegram:', error);
        }
    }

    async formatWhatsAppMessage(msg, text, isGroup, isFromMe) {
        const timestamp = new Date(msg.messageTimestamp * 1000).toLocaleString();
        const sender = msg.pushName || msg.key.participant?.split('@')[0] || 'Unknown';
        
        let prefix = isFromMe ? '📤 **You**' : `📥 **${sender}**`;
        if (isGroup) {
            const groupName = await this.getGroupName(msg.key.remoteJid);
            prefix += ` (in ${groupName})`;
        }

        let messageContent = '';
        
        // Handle different message types
        if (msg.message?.imageMessage) {
            messageContent = '🖼️ *Image*';
            if (msg.message.imageMessage.caption) {
                messageContent += `\n📝 ${msg.message.imageMessage.caption}`;
            }
        } else if (msg.message?.videoMessage) {
            messageContent = '🎥 *Video*';
            if (msg.message.videoMessage.caption) {
                messageContent += `\n📝 ${msg.message.videoMessage.caption}`;
            }
        } else if (msg.message?.audioMessage) {
            messageContent = '🎵 *Audio*';
        } else if (msg.message?.documentMessage) {
            const fileName = msg.message.documentMessage.fileName || 'Document';
            messageContent = `📄 *Document:* ${fileName}`;
        } else if (msg.message?.stickerMessage) {
            messageContent = '🎭 *Sticker*';
        } else if (msg.message?.locationMessage) {
            messageContent = '📍 *Location*';
        } else if (msg.message?.contactMessage) {
            messageContent = '👤 *Contact*';
        } else if (text) {
            messageContent = text;
        }

        return `${prefix}\n🕐 ${timestamp}\n\n${messageContent}`;
    }

    async getGroupName(groupJid) {
        try {
            const groupMetadata = await this.whatsappBot.sock.groupMetadata(groupJid);
            return groupMetadata.subject || 'Unknown Group';
        } catch (error) {
            return 'Unknown Group';
        }
    }

    async sendToTelegram(threadId, text, whatsappMsg = null) {
        try {
            // Add to queue for rate limiting
            this.messageQueue.push({
                threadId,
                text,
                whatsappMsg,
                timestamp: Date.now()
            });

            if (!this.isProcessingQueue) {
                this.processMessageQueue();
            }
        } catch (error) {
            logger.error('Error adding message to Telegram queue:', error);
        }
    }

    async processMessageQueue() {
        this.isProcessingQueue = true;

        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            
            try {
                // Send text message
                const sentMsg = await this.bot.sendMessage(this.groupId, message.text, {
                    message_thread_id: message.threadId,
                    parse_mode: 'Markdown'
                });

                // Handle media if present
                if (message.whatsappMsg) {
                    await this.handleWhatsAppMedia(message.whatsappMsg, message.threadId);
                }

                // Rate limiting - wait 100ms between messages
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                logger.error('Error processing message from queue:', error);
            }
        }

        this.isProcessingQueue = false;
    }

    async handleWhatsAppMedia(msg, threadId) {
        try {
            let mediaBuffer = null;
            let fileName = null;
            let caption = null;

            if (msg.message?.imageMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'image.jpg';
                caption = msg.message.imageMessage.caption;
            } else if (msg.message?.videoMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'video.mp4';
                caption = msg.message.videoMessage.caption;
            } else if (msg.message?.audioMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'audio.ogg';
            } else if (msg.message?.documentMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = msg.message.documentMessage.fileName || 'document';
            } else if (msg.message?.stickerMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(msg);
                fileName = 'sticker.webp';
            }

            if (mediaBuffer) {
                await this.sendMediaToTelegram(threadId, mediaBuffer, fileName, caption);
            }
        } catch (error) {
            logger.error('Error handling WhatsApp media:', error);
        }
    }

    async sendMediaToTelegram(threadId, buffer, fileName, caption = null) {
        try {
            const mimeType = mime.lookup(fileName) || 'application/octet-stream';
            
            const options = {
                message_thread_id: threadId,
                caption: caption || undefined
            };

            if (mimeType.startsWith('image/')) {
                await this.bot.sendPhoto(this.groupId, buffer, options);
            } else if (mimeType.startsWith('video/')) {
                await this.bot.sendVideo(this.groupId, buffer, options);
            } else if (mimeType.startsWith('audio/')) {
                await this.bot.sendAudio(this.groupId, buffer, options);
            } else {
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

            // Find corresponding WhatsApp user
            const userTopic = this.findUserTopicByThreadId(msg.message_thread_id);
            if (!userTopic) {
                // Check if it's a status reply
                if (msg.message_thread_id === this.topics.statusUpdates?.id) {
                    await this.handleStatusReply(msg);
                }
                return;
            }

            // Send to WhatsApp
            await this.sendToWhatsApp(userTopic.jid, msg);

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
                await this.whatsappBot.sendMessage(jid, content);
                logger.info(`✅ Message sent to WhatsApp: ${jid}`);
            }

        } catch (error) {
            logger.error('Error sending message to WhatsApp:', error);
            
            // Send error message back to Telegram
            await this.bot.sendMessage(this.groupId, 
                `❌ Failed to send message to WhatsApp: ${error.message}`, {
                message_thread_id: telegramMsg.message_thread_id
            });
        }
    }

    async downloadTelegramFile(fileId) {
        try {
            const fileInfo = await this.bot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${fileInfo.file_path}`;
            
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        } catch (error) {
            logger.error('Error downloading Telegram file:', error);
            throw error;
        }
    }

    async handleWhatsAppCall(call) {
        try {
            if (!this.topics.callLogs) return;

            const callInfo = await this.formatCallInfo(call);
            await this.bot.sendMessage(this.groupId, callInfo, {
                message_thread_id: this.topics.callLogs.id,
                parse_mode: 'Markdown'
            });

            logger.info(`📞 Call logged: ${call.from} - ${call.status}`);
        } catch (error) {
            logger.error('Error handling WhatsApp call:', error);
        }
    }

    async formatCallInfo(call) {
        const timestamp = new Date().toLocaleString();
        const caller = call.from.split('@')[0];
        const callType = call.isVideo ? '📹 Video Call' : '📞 Voice Call';
        const status = call.status === 'offer' ? 'Incoming' : 
                      call.status === 'accept' ? 'Accepted' : 
                      call.status === 'reject' ? 'Rejected' : 
                      call.status === 'timeout' ? 'Missed' : call.status;

        return `${callType}\n\n` +
               `👤 **Caller:** +${caller}\n` +
               `📊 **Status:** ${status}\n` +
               `🕐 **Time:** ${timestamp}\n` +
               `⏱️ **Duration:** ${call.duration || 'N/A'}`;
    }

    async handleWhatsAppStatus(msg) {
        try {
            if (!this.topics.statusUpdates) return;

            const statusInfo = await this.formatStatusInfo(msg);
            const sentMsg = await this.bot.sendMessage(this.groupId, statusInfo, {
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

    async formatStatusInfo(msg) {
        const timestamp = new Date(msg.messageTimestamp * 1000).toLocaleString();
        const sender = msg.pushName || msg.key.participant?.split('@')[0] || 'Unknown';
        const text = msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || 
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption || '';

        let statusContent = '';
        if (msg.message?.imageMessage) {
            statusContent = '🖼️ *Image Status*';
        } else if (msg.message?.videoMessage) {
            statusContent = '🎥 *Video Status*';
        } else if (text) {
            statusContent = `📝 *Text Status*\n\n${text}`;
        }

        return `📱 **Status Update**\n\n` +
               `👤 **From:** ${sender}\n` +
               `🕐 **Time:** ${timestamp}\n\n` +
               `${statusContent}\n\n` +
               `💬 *Reply to this message to respond on WhatsApp*`;
    }

    async handleStatusReply(telegramMsg) {
        try {
            if (!telegramMsg.reply_to_message) return;

            const statusData = this.userCache.get(`status_${telegramMsg.reply_to_message.message_id}`);
            if (!statusData) {
                await this.bot.sendMessage(this.groupId, 
                    '❌ Cannot find original status message to reply to', {
                    message_thread_id: telegramMsg.message_thread_id
                });
                return;
            }

            // Send reply to WhatsApp status
            await this.whatsappBot.sendMessage(statusData.sender, {
                text: `📱 *Status Reply:* ${telegramMsg.text}`
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
                '📸 *Profile picture updated*', {
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
            // Handle any inline button callbacks here
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
