const config = require('../config');
const logger = require('../core/logger');
const { Database } = require('../core/database');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const TelegramBridgeBot = require('./telegramBridgeBot');

class TelegramBridge {
    constructor(whatsappBot) {
        this.name = 'Telegram Bridge';
        this.version = '2.0.0';
        this.description = 'Advanced WhatsApp-Telegram Bridge with full control panel';
        
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.database = new Database();
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.systemTopics = {
            status: null,
            calls: null
        };
        this.bridgeEnabled = true;
        this.settings = {
            allowMedia: true,
            allowStickers: true,
            allowVoice: true,
            allowAudio: true,
            allowDocuments: true,
            allowVideos: true,
            syncContacts: true,
            syncStatus: true,
            syncCalls: true,
            autoUpdateProfilePics: true
        };

        this.commands = [
            {
                name: 'tgbridge',
                description: 'Toggle Telegram bridge on/off',
                category: 'admin',
                execute: this.handleBridgeCommand.bind(this)
            },
            {
                name: 'tgstatus',
                description: 'Check Telegram bridge status',
                category: 'admin',
                execute: this.handleStatusCommand.bind(this)
            }
        ];
    }

    async init() {
        try {
            await this.database.connect();
            await this.initialize();
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ') || 
            !chatId || chatId.includes('2345678901')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly');
            return;
        }

        try {
            this.telegramBot = new TelegramBridgeBot(token, this);
            await this.telegramBot.initialize();
            await this.loadMappingsFromDatabase();
            await this.createSystemTopics();
            await this.cleanupInactiveTopics();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async loadMappingsFromDatabase() {
        try {
            const mappings = await this.database.getAllTopicMappings();
            for (const mapping of mappings) {
                this.chatMappings.set(mapping.whatsappJid, mapping.telegramTopicId);
            }
            logger.info(`📊 Loaded ${mappings.length} topic mappings from database`);
        } catch (error) {
            logger.error('❌ Error loading mappings from database:', error);
        }
    }

    async createSystemTopics() {
        const chatId = config.get('telegram.chatId');
        try {
            // Check for existing system topics
            const existingTopics = await this.database.getSystemTopicMappings();
            for (const topic of existingTopics) {
                if (topic.topicName === '📱 Status Updates') {
                    this.systemTopics.status = topic.telegramTopicId;
                } else if (topic.topicName === '📞 Calls & Notifications') {
                    this.systemTopics.calls = topic.telegramTopicId;
                }
            }

            // Create Status Updates topic if not exists
            if (!this.systemTopics.status) {
                const statusTopic = await this.telegramBot.createForumTopic(chatId, '📱 Status Updates', {
                    icon_color: 0x9367DA
                });
                this.systemTopics.status = statusTopic.message_thread_id;
                await this.database.saveTopicMapping({
                    whatsappJid: 'status@broadcast',
                    telegramTopicId: statusTopic.message_thread_id,
                    topicName: '📱 Status Updates',
                    isGroup: false,
                    isActive: true,
                    messageCount: 0,
                    lastActivity: new Date()
                });
            }

            // Create Calls & Notifications topic if not exists
            if (!this.systemTopics.calls) {
                const callsTopic = await this.telegramBot.createForumTopic(chatId, '📞 Calls & Notifications', {
                    icon_color: 0xFF6B6B
                });
                this.systemTopics.calls = callsTopic.message_thread_id;
                await this.database.saveTopicMapping({
                    whatsappJid: 'calls@notifications',
                    telegramTopicId: callsTopic.message_thread_id,
                    topicName: '📞 Calls & Notifications',
                    isGroup: false,
                    isActive: true,
                    messageCount: 0,
                    lastActivity: new Date()
                });
            }

            logger.info('✅ System topics created or reused');
        } catch (error) {
            logger.error('❌ Failed to create system topics:', error);
        }
    }

    async cleanupInactiveTopics() {
        try {
            const mappings = await this.database.getAllTopicMappings();
            const inactiveThreshold = 30 * 24 * 60 * 60 * 1000; // 30 days
            const now = new Date();

            for (const mapping of mappings) {
                if (mapping.topicName === '📱 Status Updates' || mapping.topicName === '📞 Calls & Notifications') {
                    continue; // Skip system topics
                }
                if (now - new Date(mapping.lastActivity) > inactiveThreshold) {
                    await this.telegramBot.closeForumTopic(config.get('telegram.chatId'), mapping.telegramTopicId);
                    await this.database.updateTopicMapping(mapping.whatsappJid, { isActive: false });
                    this.chatMappings.delete(mapping.whatsappJid);
                    logger.info(`🗑️ Closed inactive topic: ${mapping.topicName} (ID: ${mapping.telegramTopicId})`);
                }
            }
        } catch (error) {
            logger.error('❌ Error cleaning up inactive topics:', error);
        }
    }

    async handleBridgeCommand(msg, params, context) {
        if (!context.participant.includes(config.get('bot.owner'))) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Only the bot owner can control the Telegram bridge.'
            });
        }

        const action = params[0]?.toLowerCase();
        
        if (action === 'on') {
            this.bridgeEnabled = true;
            await this.database.setSetting('bridge_enabled', true);
            await context.bot.sendMessage(context.sender, {
                text: '✅ Telegram bridge enabled!'
            });
        } else if (action === 'off') {
            this.bridgeEnabled = false;
            await this.database.setSetting('bridge_enabled', false);
            await context.bot.sendMessage(context.sender, {
                text: '❌ Telegram bridge disabled!'
            });
        } else {
            await context.bot.sendMessage(context.sender, {
                text: `🔗 *Telegram Bridge Status*\n\n` +
                      `Status: ${this.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                      `Connected Chats: ${this.chatMappings.size}\n` +
                      `Database: ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                      `Use: ${config.get('bot.prefix')}tgbridge on/off`
            });
        }
    }

    async handleStatusCommand(msg, params, context) {
        const statusMessage = `📊 *Telegram Bridge Status*\n\n` +
                             `🔗 Bridge: ${this.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                             `🤖 Telegram Bot: ${this.telegramBot ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `📊 Database: ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `💬 Active Chats: ${this.chatMappings.size}\n` +
                             `👥 Cached Users: ${this.userMappings.size}\n` +
                             `📱 System Topics: ${Object.values(this.systemTopics).filter(t => t).length}/2\n\n` +
                             `*Settings:*\n` +
                             `📷 Media: ${this.settings.allowMedia ? '✅' : '❌'}\n` +
                             `🎭 Stickers: ${this.settings.allowStickers ? '✅' : '❌'}\n` +
                             `🎵 Voice: ${this.settings.allowVoice ? '✅' : '❌'}\n` +
                             `👥 Sync Contacts: ${this.settings.syncContacts ? '✅' : '❌'}`;

        await context.bot.sendMessage(context.sender, { text: statusMessage });
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !this.bridgeEnabled) return;

        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            if (sender === 'status@broadcast') {
                return this.handleStatusUpdate(whatsappMsg, text);
            }

            await this.createUserMapping(participant, whatsappMsg);
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            if (!topicId) return;

            const messageType = this.getMessageType(whatsappMsg);
            let formattedMessage = await this.formatWhatsAppMessage(whatsappMsg, text);

            if (this.settings[`allow${messageType.charAt(0).toUpperCase() + messageType.slice(1)}`]) {
                await this.handleMediaMessage(whatsappMsg, topicId, messageType);
            } else {
                await this.telegramBot.sendMessage(config.get('telegram.chatId'), formattedMessage, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }

            await this.database.logMessage({
                whatsappMessageId: whatsappMsg.key.id,
                whatsappJid: sender,
                telegramTopicId: topicId,
                messageType,
                content: text || messageType,
                direction: 'wa_to_tg'
            });

            if (this.userMappings.has(participant)) {
                this.userMappings.get(participant).messageCount++;
            }
        } catch (error) {
            logger.error('❌ Error syncing message:', error);
        }
    }

    async handleStatusUpdate(whatsappMsg, text) {
        if (!this.settings.syncStatus || !this.systemTopics.status) return;

        const participant = whatsappMsg.key.participant;
        const userInfo = this.userMappings.get(participant);
        const chatId = config.get('telegram.chatId');

        const statusMessage = text || '[Media status]';
        await this.telegramBot.sendMessage(chatId, statusMessage, {
            message_thread_id: this.systemTopics.status,
            parse_mode: 'Markdown'
        });
    }

    async handleCallNotification(callData) {
        if (!this.settings.syncCalls || !this.systemTopics.calls) return;

        const chatId = config.get('telegram.chatId');
        const callMessage = `📞 *Call Notification*\n` +
                           `Type: ${callData.type || 'Unknown'}\n` +
                           `From: ${callData.from || 'Unknown'}\n` +
                           `Time: ${new Date().toLocaleString()}`;

        await this.telegramBot.sendMessage(chatId, callMessage, {
            message_thread_id: this.systemTopics.calls,
            parse_mode: 'Markdown'
        });
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        let userName = 'Unknown User';
        let userPhone = participant.split('@')[0];
        let profilePicUrl = '';
        
        try {
            if (this.whatsappBot.sock) {
                try {
                    const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                    if (contact && contact[0]) {
                        userName = contact[0].notify || userPhone;
                    }
                } catch (error) {
                    logger.debug('Could not fetch contact info:', error);
                }
                try {
                    profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(participant, 'image');
                } catch (error) {
                    logger.debug('Could not fetch profile picture:', error);
                }
            }
        } catch (error) {
            logger.debug('Error creating user mapping:', error);
        }

        const userMapping = {
            name: userName,
            phone: userPhone,
            profilePicUrl,
            firstSeen: new Date(),
            messageCount: 0
        };

        this.userMappings.set(participant, userMapping);

        await this.database.saveContact({
            jid: participant,
            name: userName,
            phone: userPhone,
            profilePicUrl,
            isGroup: participant.endsWith('@g.us'),
            lastSeen: new Date(),
            messageCount: 0
        });

        logger.debug(`👤 Created user mapping: ${userName} (${userPhone})`);
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        if (this.chatMappings.has(chatJid)) {
            logger.debug(`🔄 Reusing existing topic for ${chatJid}: ${this.chatMappings.get(chatJid)}`);
            return this.chatMappings.get(chatJid);
        }

        const chatId = config.get('telegram.chatId');
        try {
            const isGroup = chatJid.endsWith('@g.us');
            let topicName;
            let profilePicUrl = '';
            
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `👥 ${groupMeta.subject}`;
                    try {
                        profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(chatJid, 'image');
                    } catch (error) {
                        logger.debug('Could not fetch group profile picture:', error);
                    }
                } catch (error) {
                    topicName = `👥 Group Chat`;
                }
            } else {
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                topicName = `👤 ${userInfo ? userInfo.name : 'Private Chat'}`;
                profilePicUrl = userInfo ? userInfo.profilePicUrl : '';
            }

            // Check database for existing topic with same name
            const existingMapping = await this.database.getTopicMappingByName(topicName);
            if (existingMapping) {
                this.chatMappings.set(chatJid, existingMapping.telegramTopicId);
                logger.debug(`🔄 Reusing topic from database: ${topicName} (ID: ${existingMapping.telegramTopicId})`);
                return existingMapping.telegramTopicId;
            }

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            
            await this.database.saveTopicMapping({
                whatsappJid: chatJid,
                telegramTopicId: topic.message_thread_id,
                topicName,
                isGroup,
                isActive: true,
                messageCount: 0,
                lastActivity: new Date()
            });

            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup, profilePicUrl);
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, chatJid, isGroup, profilePicUrl) {
        const chatId = config.get('telegram.chatId');
        const welcomeMsg = `🔗 *WhatsApp Bridge Connected*\n\n` +
                          `📱 Chat Type: ${isGroup ? 'Group' : 'Private'}\n` +
                          `🆔 WhatsApp ID: \`${chatJid}\`\n` +
                          `⏰ Connected: ${new Date().toLocaleString()}\n\n` +
                          `💬 Messages from this WhatsApp chat will appear here.\n` +
                          `📤 Reply to messages here to send back to WhatsApp.`;

        if (profilePicUrl) {
            try {
                await this.telegramBot.sendPhoto(chatId, profilePicUrl, {
                    message_thread_id: topicId,
                    caption: welcomeMsg,
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                await this.telegramBot.sendMessage(chatId, welcomeMsg, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }
        } else {
            await this.telegramBot.sendMessage(chatId, welcomeMsg, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
    }

    async formatWhatsAppMessage(whatsappMsg, text) {
        const messageType = this.getMessageType(whatsappMsg);
        if (text) {
            return text;
        }
        switch (messageType) {
            case 'image': return '[Image]';
            case 'video': return '[Video]';
            case 'audio': return '[Audio]';
            case 'voice': return '[Voice]';
            case 'document': return '[Document]';
            case 'sticker': return '[Sticker]';
            default: return '[Unknown Message]';
        }
    }

    getMessageType(whatsappMsg) {
        if (whatsappMsg.message?.imageMessage) return 'image';
        if (whatsappMsg.message?.videoMessage) return 'video';
        if (whatsappMsg.message?.audioMessage) {
            return whatsappMsg.message.audioMessage.ptt ? 'voice' : 'audio';
        }
        if (whatsappMsg.message?.documentMessage) return 'document';
        if (whatsappMsg.message?.stickerMessage) return 'sticker';
        return 'text';
    }

    async handleMediaMessage(whatsappMsg, topicId, messageType) {
        const chatId = config.get('telegram.chatId');
        try {
            let mediaUrl, filePath;
            if (whatsappMsg.message?.imageMessage) {
                mediaUrl = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg, 'buffer');
                filePath = path.join(__dirname, `../temp/image_${whatsappMsg.key.id}.jpg`);
                await fs.writeFile(filePath, mediaUrl);
                await this.telegramBot.sendPhoto(chatId, filePath, { message_thread_id: topicId });
            } else if (whatsappMsg.message?.videoMessage) {
                mediaUrl = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg, 'buffer');
                filePath = path.join(__dirname, `../temp/video_${whatsappMsg.key.id}.mp4`);
                await fs.writeFile(filePath, mediaUrl);
                await this.telegramBot.sendVideo(chatId, filePath, { message_thread_id: topicId });
            } else if (whatsappMsg.message?.audioMessage) {
                mediaUrl = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg, 'buffer');
                filePath = path.join(__dirname, `../temp/audio_${whatsappMsg.key.id}.mp3`);
                await fs.writeFile(filePath, mediaUrl);
                await this.telegramBot.sendAudio(chatId, filePath, { message_thread_id: topicId });
            } else if (whatsappMsg.message?.documentMessage) {
                mediaUrl = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg, 'buffer');
                filePath = path.join(__dirname, `../temp/doc_${whatsappMsg.key.id}`);
                await fs.writeFile(filePath, mediaUrl);
                await this.telegramBot.sendDocument(chatId, filePath, { message_thread_id: topicId });
            } else if (whatsappMsg.message?.stickerMessage) {
                mediaUrl = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg, 'buffer');
                filePath = path.join(__dirname, `../temp/sticker_${whatsappMsg.key.id}.webp`);
                await fs.writeFile(filePath, mediaUrl);
                await this.telegramBot.sendSticker(chatId, filePath, { message_thread_id: topicId });
            }
            await fs.unlink(filePath).catch(() => {});
        } catch (error) {
            logger.error('❌ Failed to handle media message:', error);
            await this.telegramBot.sendMessage(chatId, `[${messageType}]`, { message_thread_id: topicId });
        }
    }

    async handleTelegramMessage(msg) {
        if (!msg.reply_to_message || !this.bridgeEnabled) return;

        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            let messageContent;
            if (msg.text) {
                messageContent = { text: msg.text };
            } else if (msg.photo) {
                messageContent = await this.handleTelegramPhoto(msg, whatsappJid);
            } else if (msg.video) {
                messageContent = await this.handleTelegramVideo(msg, whatsappJid);
            } else if (msg.audio || msg.voice) {
                messageContent = await this.handleTelegramVoice(msg, whatsappJid);
            } else if (msg.document) {
                messageContent = await this.handleTelegramDocument(msg, whatsappJid);
            } else if (msg.sticker) {
                messageContent = await this.handleTelegramSticker(msg, whatsappJid);
            } else if (msg.video_note) {
                messageContent = await this.handleTelegramVideoNote(msg, whatsappJid);
            } else {
                messageContent = { text: '[Media message]' };
            }

            await this.whatsappBot.sendMessage(whatsappJid, messageContent);
            await this.telegramBot.sendMessage(msg.chat.id, '✅ Message sent to WhatsApp', {
                message_thread_id: topicId,
                reply_to_message_id: msg.message_id
            });

            await this.database.logMessage({
                whatsappMessageId: null,
                whatsappJid,
                telegramTopicId: topicId,
                messageType: messageContent.text ? 'text' : Object.keys(messageContent)[0] || 'unknown',
                content: messageContent.text || '[Media]',
                direction: 'tg_to_wa'
            });
        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
        }
    }

    async handleTelegramPhoto(msg, whatsappJid) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await this.telegramBot.getFile(fileId);
        const filePath = path.join(__dirname, `../temp/photo_${msg.message_id}.jpg`);
        await this.downloadTelegramFile(file.file_path, filePath);
        const messageContent = { image: { url: filePath } };
        await fs.unlink(filePath).catch(() => {});
        return messageContent;
    }

    async handleTelegramVideo(msg, whatsappJid) {
        const fileId = msg.video.file_id;
        const file = await this.telegramBot.getFile(fileId);
        const filePath = path.join(__dirname, `../temp/video_${msg.message_id}.mp4`);
        await this.downloadTelegramFile(file.file_path, filePath);
        const messageContent = { video: { url: filePath } };
        await fs.unlink(filePath).catch(() => {});
        return messageContent;
    }

    async handleTelegramVoice(msg, whatsappJid) {
        const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
        const file = await this.telegramBot.getFile(fileId);
        const filePath = path.join(__dirname, `../temp/voice_${msg.message_id}.ogg`);
        await this.downloadTelegramFile(file.file_path, filePath);
        const messageContent = { audio: { url: filePath, ptt: true } };
        await fs.unlink(filePath).catch(() => {});
        return messageContent;
    }

    async handleTelegramDocument(msg, whatsappJid) {
        const fileId = msg.document.file_id;
        const file = await this.telegramBot.getFile(fileId);
        const filePath = path.join(__dirname, `../temp/doc_${msg.message_id}`);
        await this.downloadTelegramFile(file.file_path, filePath);
        const messageContent = { document: { url: filePath } };
        await fs.unlink(filePath).catch(() => {});
        return messageContent;
    }

    async handleTelegramSticker(msg, whatsappJid) {
        const fileId = msg.sticker.file_id;
        const file = await this.telegramBot.getFile(fileId);
        const filePath = path.join(__dirname, `../temp/sticker_${msg.message_id}.webp`);
        await this.downloadTelegramFile(file.file_path, filePath);
        const messageContent = { sticker: { url: filePath } };
        await fs.unlink(filePath).catch(() => {});
        return messageContent;
    }

    async handleTelegramVideoNote(msg, whatsappJid) {
        const fileId = msg.video_note.file_id;
        const file = await this.telegramBot.getFile(fileId);
        const filePath = path.join(__dirname, `../temp/videonote_${msg.message_id}.mp4`);
        await this.downloadTelegramFile(file.file_path, filePath);
        const messageContent = { video: { url: filePath } };
        await fs.unlink(filePath).catch(() => {});
        return messageContent;
    }

    async downloadTelegramFile(filePath, destPath) {
        const url = `https://api.telegram.org/file/bot${config.get('telegram.botToken')}/${filePath}`;
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        await fs.writeFile(destPath, response.data);
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    async syncAllContacts() {
        try {
            const contacts = await this.database.getAllContacts();
            for (const contact of contacts) {
                await this.updateContactInfo(contact.jid);
            }
            logger.info(`✅ Synced ${contacts.length} contacts`);
        } catch (error) {
            logger.error('❌ Error syncing contacts:', error);
        }
    }

    async updateContactInfo(jid) {
        try {
            if (!this.whatsappBot.sock) return;

            let userName = jid.split('@')[0];
            let profilePicUrl = '';

            try {
                const contact = await this.whatsappBot.sock.onWhatsApp(jid);
                if (contact && contact[0]) {
                    userName = contact[0].notify || userName;
                }
            } catch (error) {
                logger.debug('Could not fetch contact info:', error);
            }

            try {
                profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            } catch (error) {
                logger.debug('Could not fetch profile picture:', error);
            }

            await this.database.saveContact({
                jid,
                name: userName,
                phone: jid.split('@')[0],
                profilePicUrl,
                isGroup: jid.endsWith('@g.us'),
                lastSeen: new Date()
            });

            if (this.userMappings.has(jid)) {
                const userInfo = this.userMappings.get(jid);
                userInfo.name = userName;
                userInfo.profilePicUrl = profilePicUrl;
            }
        } catch (error) {
            logger.error(`❌ Error updating contact ${jid}:`, error);
        }
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

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: ${this.bridgeEnabled ? 'Active' : 'Inactive'}\n` +
            `📊 Database: ${this.database.isConnected ? 'Connected' : 'Disconnected'}\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stop();
            logger.info('📱 Telegram bridge stopped');
        }
        if (this.database) {
            await this.database.disconnect();
        }
    }
}

module.exports = TelegramBridge;
