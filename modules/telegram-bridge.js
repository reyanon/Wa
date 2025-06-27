//   Imports + Constructor + initialize() + setupTelegramHandlers()
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

const TelegramMessageHandler = require('./telegram-message-handler'); // NEW

ffmpeg.setFfmpegPath(ffmpegStatic);

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.messageHandler = null;
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.tempDir = path.join(__dirname, '../temp');
        this.profilePicCache = new Map();
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token) {
            logger.warn('⚠️ Telegram bot token not configured.');
            return;
        }

        try {
            await fs.ensureDir(this.tempDir);
            this.telegramBot = new TelegramBot(token, { polling: true });

            // Initialize and delegate Telegram message handling
            this.messageHandler = new TelegramMessageHandler(this);
            await this.messageHandler.initializeHandlers();

            logger.info('✅ Telegram bridge initialized');
        } catch (err) {
            logger.error('❌ Failed to initialize Telegram bridge:', err);
        }
    }
// Topics, Mapping, Welcome Messages

    async getOrCreateTopic(jid, msg = {}) {
        if (this.chatMappings.has(jid)) {
            return this.chatMappings.get(jid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId) return null;

        let topicName = 'Unknown';
        let iconColor = 0x7ABA3C;
        const isGroup = jid.endsWith('@g.us');
        const isStatus = jid === 'status@broadcast';
        const isCall = jid === 'call@broadcast';

        try {
            if (isStatus) {
                topicName = `📊 Status`;
                iconColor = 0xFF6B35;
            } else if (isCall) {
                topicName = `📞 Calls`;
                iconColor = 0xFF4757;
            } else if (isGroup) {
                const groupMeta = await this.whatsappBot.sock.groupMetadata(jid);
                topicName = groupMeta.subject;
                iconColor = 0x6FB9F0;
            } else {
                const contact = this.userMappings.get(jid);
                topicName = contact?.name || jid.split('@')[0];
            }

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
            });

            this.chatMappings.set(jid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);

            if (!isStatus && !isCall) {
                await this.sendWelcomeMessage(topic.message_thread_id, jid, isGroup);
            }

            return topic.message_thread_id;
        } catch (err) {
            logger.error('❌ Failed to create topic:', err);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, jid, isGroup) {
        try {
            const chatId = config.get('telegram.chatId');
            let welcomeText = '';

            if (isGroup) {
                const groupMeta = await this.whatsappBot.sock.groupMetadata(jid);
                welcomeText = `🏷️ *Group*: ${groupMeta.subject}\n🆔 ${jid}\n👥 Members: ${groupMeta.participants.length}`;
            } else {
                const phone = jid.split('@')[0];
                const user = this.userMappings.get(jid);
                welcomeText = `👤 *Contact*: ${user?.name || 'Unknown'}\n📱 +${phone}\n🆔 ${jid}`;
            }

            await this.telegramBot.sendMessage(chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (err) {
            logger.debug('Welcome message skipped:', err.message);
        }
    }

    async cacheUserInfo(jid, pushName) {
        const phone = jid.split('@')[0];
        this.userMappings.set(jid, {
            name: pushName || phone,
            phone
        });
    }
// syncMessage, Spoilers, Confirmations, Calls

    async syncMessage(waMsg, text) {
        const jid = waMsg.key.remoteJid;
        const chatId = config.get('telegram.chatId');
        if (!this.telegramBot || !chatId) return;

        const sender = waMsg.key.participant || jid;
        if (!this.userMappings.has(sender)) {
            await this.cacheUserInfo(sender, waMsg.pushName);
        }

        const topicId = await this.getOrCreateTopic(jid, waMsg);
        if (!topicId) return;

        const isViewOnce =
            waMsg.message?.imageMessage?.viewOnce ||
            waMsg.message?.videoMessage?.viewOnce;

        if (isViewOnce) {
            await this.sendSpoilerMedia(waMsg, topicId);
            return;
        }

        const name = this.userMappings.get(sender)?.name || sender.split('@')[0];
        const content = text || this.extractText(waMsg.message);
        if (!content) return;

        const sent = await this.telegramBot.sendMessage(chatId, `💬 *${name}*:\n${content}`, {
            message_thread_id: topicId,
            parse_mode: 'Markdown'
        });

        await this.sendReactionReply(chatId, sent.message_id);
    }

    async sendSpoilerMedia(msg, topicId) {
        try {
            const chatId = config.get('telegram.chatId');
            const type = msg.message?.imageMessage ? 'image' : 'video';
            const stream = await downloadContentFromMessage(msg.message[`${type}Message`], type);
            const filePath = path.join(this.tempDir, `${Date.now()}.${type === 'image' ? 'jpg' : 'mp4'}`);
            const write = fs.createWriteStream(filePath);

            for await (const chunk of stream) {
                write.write(chunk);
            }
            write.end();

            const opts = {
                message_thread_id: topicId,
                has_spoiler: true,
                caption: '👁️‍🗨️ View Once Media',
                parse_mode: 'Markdown'
            };

            if (type === 'image') {
                await this.telegramBot.sendPhoto(chatId, filePath, opts);
            } else {
                await this.telegramBot.sendVideo(chatId, filePath, opts);
            }

            await fs.remove(filePath);
        } catch (err) {
            logger.error('❌ Failed to send spoiler media:', err);
        }
    }

    async sendReactionReply(chatId, messageId) {
        try {
            await this.telegramBot.sendMessage(chatId, '✅ Delivered', {
                reply_to_message_id: messageId
            });
        } catch (err) {
            logger.debug('❌ Delivery reaction failed silently:', err.message);
        }
    }

    async handleCallNotification(call) {
        try {
            const chatId = config.get('telegram.chatId');
            const jid = call.from;
            const topicId = await this.getOrCreateTopic('call@broadcast');
            const name = this.userMappings.get(jid)?.name || jid.split('@')[0];
            const phone = jid.split('@')[0];

            const timestamp = new Date(call.timestamp * 1000).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
            });

            const msg = `📞 *${name}* (+${phone}) — *${timestamp}*\nIncoming Call`;

            await this.telegramBot.sendMessage(chatId, msg, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (err) {
            logger.error('❌ Call notification failed:', err);
        }
    }

    extractText(msg) {
        return msg?.conversation ||
            msg?.extendedTextMessage?.text ||
            msg?.imageMessage?.caption ||
            msg?.videoMessage?.caption ||
            msg?.documentMessage?.caption ||
            msg?.audioMessage?.caption ||
            '';
    }
    async sendProfilePicture(topicId, jid, updated = false) {
        try {
            const chatId = config.get('telegram.chatId');
            const url = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            if (!url) return;

            const buffer = await axios.get(url, { responseType: 'arraybuffer' }).then(res => res.data);
            const fileName = `${jid.split('@')[0]}_profile.jpg`;
            const filePath = path.join(this.tempDir, fileName);

            await fs.writeFile(filePath, buffer);

            const caption = updated
                ? `📸 Profile picture updated: +${jid.split('@')[0]}`
                : `📸 Profile picture: +${jid.split('@')[0]}`;

            await this.telegramBot.sendPhoto(chatId, filePath, {
                caption,
                message_thread_id: topicId
            });

            await fs.remove(filePath);
        } catch (err) {
            logger.error('❌ Failed to send profile picture:', err);
        }
    }

    async notifyAboutTextChange(jid, aboutText) {
        try {
            const topicId = await this.getOrCreateTopic(jid);
            const chatId = config.get('telegram.chatId');
            const name = this.userMappings.get(jid)?.name || jid.split('@')[0];

            const message = `✏️ *${name}* updated their *About*:\n\n_${aboutText}_`;
            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (err) {
            logger.error('❌ Failed to send about/bio update:', err);
        }
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, tid] of this.chatMappings.entries()) {
            if (tid === topicId) return jid;
        }
        return null;
    }

    async syncWhatsAppConnection() {
        try {
            const ownerJid = config.get('bot.owner');
            if (!ownerJid) return;

            const chatId = config.get('telegram.chatId');
            const msg = `🟢 WhatsApp connected as *${ownerJid}*`;
            await this.telegramBot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } catch (err) {
            logger.warn('Telegram WA sync failed:', err.message);
        }
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        try {
            await this.telegramBot.stopPolling();
            logger.info('📴 Telegram polling stopped');
        } catch (e) {
            logger.warn('Telegram shutdown error:', e.message);
        }

        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned');
        } catch (e) {
            logger.warn('Temp cleanup error:', e.message);
        }

        logger.info('✅ Telegram bridge shutdown complete');
    }
}

module.exports = TelegramBridge;
