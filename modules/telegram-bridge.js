const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const fs = require('fs-extra');
const path = require('path');

class TelegramBridge {
    constructor(whatsappBot) {
        this.bot = whatsappBot;
        this.telegram = null;
        this.chatId = config.get('telegram.chatId');
        this.token = config.get('telegram.botToken');
        this.tempDir = path.join(__dirname, '../temp');
        this.topicMap = new Map();
        this.userMap = new Map();
        this.statusMap = new Map();
    }

    async initialize() {
        if (!config.get('telegram.enabled') || !this.token) return;

        try {
            await fs.ensureDir(this.tempDir);
            this.telegram = new TelegramBot(this.token, { polling: true });
            this.setupHandlers();
            logger.info('✅ Telegram bridge initialized');
            await this.sendStartupMessage();
        } catch (err) {
            logger.error('❌ Failed to init Telegram bridge:', err);
        }
    }

    async sendStartupMessage() {
        try {
            await this.telegram.sendMessage(this.token.split(':')[0], `🚀 Bot started: ${config.get('bot.name')} v${config.get('bot.version')}`);
        } catch (err) {
            logger.debug('Startup message failed:', err.message);
        }
    }

    setupHandlers() {
        this.telegram.on('message', async (msg) => {
            if (!msg.is_topic_message || msg.chat.type !== 'supergroup') return;
            const topicId = msg.message_thread_id;
            const jid = this.findJidByTopic(topicId);
            if (!jid || !msg.text) return;
            try {
                await this.bot.sendMessage(jid, { text: msg.text });
            } catch (e) {
                logger.error('❌ Telegram → WhatsApp error:', e);
            }
        });
    }

    async syncMessage(msg, text) {
        const jid = msg.key.remoteJid;
        const participant = msg.key.participant || jid;

        await this.mapUser(participant, msg);
        const topicId = await this.getOrCreateTopic(jid, msg);
        if (!topicId || !text) return;

        try {
            await this.telegram.sendMessage(this.chatId, text, {
                message_thread_id: topicId
            });
        } catch (e) {
            logger.error('❌ WhatsApp → Telegram error:', e);
        }
    }

    async getOrCreateTopic(jid, msg) {
        if (this.topicMap.has(jid)) return this.topicMap.get(jid);

        const name = this.userMap.get(jid)?.name || jid.split('@')[0];
        try {
            const topic = await this.telegram.createForumTopic(this.chatId, name);
            this.topicMap.set(jid, topic.message_thread_id);
            await this.sendUserInfo(topic.message_thread_id, jid);
            return topic.message_thread_id;
        } catch (e) {
            logger.error('❌ Create topic failed:', e);
            return null;
        }
    }

    async sendUserInfo(topicId, jid) {
        const user = this.userMap.get(jid);
        const text = `👤 ${user?.name || 'Unknown'}\n📱 +${user?.phone || jid.split('@')[0]}`;

        try {
            const msg = await this.telegram.sendMessage(this.chatId, text, {
                message_thread_id: topicId
            });
            await this.telegram.pinChatMessage(this.chatId, msg.message_id);
            await this.sendProfilePicture(jid, topicId);
        } catch (e) {
            logger.debug('User info failed:', e.message);
        }
    }

    async sendProfilePicture(jid, topicId) {
        try {
            const url = await this.bot.sock.profilePictureUrl(jid, 'image');
            if (!url) return;
            await this.telegram.sendPhoto(this.chatId, url, {
                message_thread_id: topicId,
                caption: '📸 Profile Picture'
            });
        } catch {}
    }

    async handleStatus(msg, text) {
        const jid = msg.key.participant || msg.key.remoteJid;
        const topicId = await this.getOrCreateTopic('status@' + jid, msg);
        if (!topicId) return;

        const user = this.userMap.get(jid);
        const message = `📣 *${user?.name || jid.split('@')[0]}*\n${text}`;

        try {
            const sent = await this.telegram.sendMessage(this.chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            this.statusMap.set(sent.message_id, jid);
        } catch (e) {
            logger.error('❌ Status message failed:', e);
        }
    }

    async mapUser(jid, msg) {
        if (this.userMap.has(jid)) return;

        const phone = jid.split('@')[0];
        const name = msg.pushName || null;
        this.userMap.set(jid, { name, phone });
    }

    findJidByTopic(topicId) {
        for (const [jid, id] of this.topicMap.entries()) {
            if (id === topicId) return jid;
        }
        return null;
    }

    async shutdown() {
        try {
            if (this.telegram) await this.telegram.stopPolling();
        } catch {}
    }
}

module.exports = TelegramBridge;
