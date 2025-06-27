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

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WA JID -> Telegram topic ID
        this.userMappings = new Map(); // WA user JID -> contact info
        this.profilePicCache = new Map(); // WA JID -> profile pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.statusMessageIds = new Map();
        this.isProcessing = false;
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            await fs.ensureDir(this.tempDir);
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

// Handlers + Reaction Replies

    async setupTelegramHandlers() {
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                if (msg.text) await this.handleTelegramMessage(msg);
            }
        });

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

        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    async confirmTelegramDelivery(bot, chatId, messageId) {
        try {
            await bot.sendMessage(chatId, '✅ Delivered', {
                reply_to_message_id: messageId
            });
        } catch (err) {
            logger.debug('✅ Telegram delivery reaction failed silently:', err?.message);
        }
    }

    async confirmTelegramFailure(bot, chatId, messageId) {
        try {
            await bot.sendMessage(chatId, '❌ Failed to deliver', {
                reply_to_message_id: messageId
            });
        } catch (err) {
            logger.debug('❌ Telegram failure reaction failed silently:', err?.message);
        }
    }

    async confirmStatusReply(bot, chatId, messageId) {
        try {
            await bot.sendMessage(chatId, '❤️ Replied to status', {
                reply_to_message_id: messageId
            });
        } catch (err) {
            logger.debug('❤️ Telegram status reply confirm failed:', err?.message);
        }
    }

// WA → TG Topics, Welcome, Spoilers

    async getOrCreateTopic(jid, msg) {
        if (this.chatMappings.has(jid)) {
            return this.chatMappings.get(jid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId) return null;

        let topicName = 'Unknown';
        let iconColor = 0x7ABA3C;

        try {
            const isGroup = jid.endsWith('@g.us');
            const isStatus = jid === 'status@broadcast';
            const isCall = jid === 'call@broadcast';

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
                welcomeText = `🏷️ **Group**: ${groupMeta.subject}\n🆔 ${jid}\n👥 Members: ${groupMeta.participants.length}`;
            } else {
                const phone = jid.split('@')[0];
                const user = this.userMappings.get(jid);
                welcomeText = `👤 **Contact**: ${user?.name || 'Unknown'}\n📱 +${phone}\n🆔 ${jid}`;
            }

            await this.telegramBot.sendMessage(chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (err) {
            logger.debug('Could not send welcome message:', err);
        }
    }

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

        // Handle view-once
        const isViewOnce =
            waMsg.message?.imageMessage?.viewOnce ||
            waMsg.message?.videoMessage?.viewOnce;

        if (isViewOnce) {
            await this.handleViewOnceSpoiler(waMsg, topicId);
            return;
        }

        const sentText = text || this.extractText(waMsg.message);
        if (sentText) {
            const name = this.userMappings.get(sender)?.name || sender.split('@')[0];
            const msg = `💬 *${name}*:\n${sentText}`;
            await this.telegramBot.sendMessage(chatId, msg, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
    }

    async handleViewOnceSpoiler(msg, topicId) {
        try {
            const contentType = msg.message?.imageMessage ? 'image' : 'video';
            const stream = await downloadContentFromMessage(
                msg.message[`${contentType}Message`],
                contentType
            );

            const filePath = path.join(this.tempDir, `${Date.now()}.${contentType === 'image' ? 'jpg' : 'mp4'}`);
            const fileStream = fs.createWriteStream(filePath);
            for await (const chunk of stream) {
                fileStream.write(chunk);
            }
            fileStream.end();

            const opts = {
                message_thread_id: topicId,
                has_spoiler: true,
                caption: '👁️‍🗨️ View Once Media',
                parse_mode: 'Markdown'
            };

            if (contentType === 'image') {
                await this.telegramBot.sendPhoto(config.get('telegram.chatId'), filePath, opts);
            } else {
                await this.telegramBot.sendVideo(config.get('telegram.chatId'), filePath, opts);
            }

            await fs.remove(filePath);
        } catch (err) {
            logger.error('❌ Failed to send view-once media as spoiler:', err);
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

    async cacheUserInfo(jid, pushName) {
        const phone = jid.split('@')[0];
        this.userMappings.set(jid, {
            name: pushName || phone,
            phone
        });
    }

// Media Handling, Voice, Location, Contact

    async handleTelegramMedia(msg, mediaType) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            if (!whatsappJid) return;

            let fileId, fileName, caption = msg.caption || '';
            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo.at(-1).file_id;
                    fileName = `photo_${Date.now()}.jpg`;
                    break;
                case 'video':
                    fileId = msg.video.file_id;
                    fileName = `video_${Date.now()}.mp4`;
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

            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            switch (mediaType) {
                case 'photo':
                    await this.whatsappBot.sendMessage(whatsappJid, { image: { url: filePath }, caption });
                    break;
                case 'video':
                    await this.whatsappBot.sendMessage(whatsappJid, { video: { url: filePath }, caption });
                    break;
                case 'voice':
                    const converted = path.join(this.tempDir, `voice_${Date.now()}.ogg`);
                    await this.convertToVoice(filePath, converted);
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: converted },
                        ptt: true,
                        mimetype: 'audio/ogg',
                        seconds: await this.getAudioDuration(converted)
                    });
                    await fs.remove(converted);
                    break;
                case 'audio':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: filePath },
                        mimetype: mime.lookup(fileName) || 'audio/mpeg',
                        fileName
                    });
                    break;
                case 'document':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        document: { url: filePath },
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        fileName
                    });
                    break;
                case 'sticker':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        sticker: { url: filePath }
                    });
                    break;
            }

            await fs.remove(filePath);
            await this.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error(`❌ Failed to handle ${mediaType} message:`, error);
            await this.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
        }
    }

    async convertToVoice(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioCodec('libopus')
                .format('ogg')
                .audioChannels(1)
                .audioFrequency(16000)
                .audioBitrate('24k')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    }

    async getAudioDuration(filePath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) reject(err);
                else resolve(Math.floor(metadata.format.duration || 0));
            });
        });
    }

    async handleTelegramLocation(msg) {
        try {
            const jid = this.findWhatsAppJidByTopic(msg.message_thread_id);
            if (!jid) return;

            await this.whatsappBot.sendMessage(jid, {
                location: {
                    degreesLatitude: msg.location.latitude,
                    degreesLongitude: msg.location.longitude
                }
            });

            await this.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (err) {
            logger.error('❌ Error sending Telegram location to WA:', err);
            await this.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
        }
    }

    async handleTelegramContact(msg) {
        try {
            const jid = this.findWhatsAppJidByTopic(msg.message_thread_id);
            if (!jid) return;

            const phone = msg.contact.phone_number;
            const name = msg.contact.first_name || phone;
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL:${phone}\nEND:VCARD`;

            await this.whatsappBot.sendMessage(jid, {
                contacts: {
                    displayName: name,
                    contacts: [{ vcard }]
                }
            });

            await this.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (err) {
            logger.error('❌ Error sending contact from TG to WA:', err);
            await this.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
        }
    }

    async ha
//  WA → TG Reactions, About, Calls, Shutdown

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, tid] of this.chatMappings.entries()) {
            if (tid === topicId) return jid;
        }
        return null;
    }

    async forwardWhatsAppReaction(jid, reaction) {
        try {
            const topicId = await this.getOrCreateTopic(jid, { key: { remoteJid: jid } });
            const chatId = config.get('telegram.chatId');
            const userInfo = this.userMappings.get(reaction.sender) || {};
            const name = userInfo.name || reaction.sender.split('@')[0];

            const message = `❤️ Reaction from *${name}*: \`${reaction.emoji || '❤️'}\``;
            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            logger.debug(`💬 Forwarded reaction from ${name}`);
        } catch (error) {
            logger.error('❌ Failed to forward WhatsApp reaction:', error);
        }
    }

    async notifyAboutTextChange(jid, aboutText) {
        try {
            const topicId = await this.getOrCreateTopic(jid, { key: { remoteJid: jid } });
            const chatId = config.get('telegram.chatId');
            const userInfo = this.userMappings.get(jid) || {};
            const name = userInfo.name || jid.split('@')[0];

            const message = `✏️ *${name}* updated their *About*:\n\n_${aboutText}_`;
            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            logger.debug(`📝 Sent about change notification for ${name}`);
        } catch (error) {
            logger.error('❌ Failed to send about change notification:', error);
        }
    }

    async handleCallNotification(call) {
        try {
            const chatId = config.get('telegram.chatId');
            const jid = call.from;
            const topicId = await this.getOrCreateTopic('call@broadcast', {});
            const name = this.userMappings.get(jid)?.name || jid.split('@')[0];
            const phone = jid.split('@')[0];

            const timestamp = new Date(call.timestamp * 1000).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
            });

            const message = `📞 *${name}* (+${phone}) — *${timestamp}*\nIncoming Call`;
            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (err) {
            logger.error('❌ Failed to send call notification:', err);
        }
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        try {
            await this.telegramBot.stopPolling();
            logger.info('📴 Telegram polling stopped');
        } catch (e) {
            logger.warn('Telegram shutdown failed:', e.message);
        }

        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned');
        } catch (e) {
            logger.warn('Temp cleanup failed:', e.message);
        }

        logger.info('✅ Telegram bridge shutdown complete');
    }
}

module.exports = TelegramBridge;

