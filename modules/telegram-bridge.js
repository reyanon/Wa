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

const reactions = require('./reactionHandler');
const confirm = require('./telegramBridge-confirmation');

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
            await fs.ensureDir(this.tempDir);
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
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

        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

// Message Syncing, Topic Creation, Welcome Messages, Profile Pics

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
        await this.createUserMapping(participant, whatsappMsg);
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);

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
            const messageId = await this.sendSimpleMessage(topicId, text, sender);
            if (sender === 'status@broadcast') {
                this.statusMessageIds.set(messageId, whatsappMsg.key);
            }
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        let userName = null;
        let userPhone = participant.split('@')[0];

        try {
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0] && contact[0].notify) {
                    userName = contact[0].notify;
                }

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
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                const phone = participant.split('@')[0];
                topicName = userInfo?.name || phone;
            }

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);

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

            await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);
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

                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error);
        }
    }

// Telegram → WhatsApp Messaging, WhatsApp → Telegram Media & Location

    async handleTelegramMessage(msg) {
        if (msg.photo || msg.video || msg.video_note || msg.voice || msg.audio || msg.document || msg.sticker || msg.location || msg.contact) {
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

            if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
                await this.handleStatusReply(msg);
                return;
            }

            await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            await confirm.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
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

            const statusJid = originalStatusKey.participant || originalStatusKey.remoteJid;
            await this.whatsappBot.sendMessage(statusJid, { text: msg.text });
            await confirm.confirmStatusReply(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
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

    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                return;
            }

            await this.whatsappBot.sendMessage(whatsappJid, {
                location: {
                    degreesLatitude: msg.location.latitude,
                    degreesLongitude: msg.location.longitude
                }
            });

            await confirm.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
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

            await confirm.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
        }
    }

//  Telegram ↔ WhatsApp Media Handling, Audio Conversion, Utilities

    async handleTelegramMedia(msg, mediaType) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
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

            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            switch (mediaType) {
                case 'photo':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        image: { url: filePath },
                        caption: caption
                    });
                    break;
                case 'video':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        video: { url: filePath },
                        caption: caption
                    });
                    break;
                case 'video_note':
                    const convertedPath = path.join(this.tempDir, `converted_video_note_${Date.now()}.mp4`);
                    await this.convertVideoNote(filePath, convertedPath);
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        video: { url: convertedPath },
                        ptv: true,
                        caption: caption
                    });
                    await fs.unlink(convertedPath).catch(() => {});
                    break;
                case 'voice':
                    const voicePath = path.join(this.tempDir, `voice_${Date.now()}.ogg`);
                    const waveform = await this.generateWaveform(filePath);
                    await this.convertToWhatsAppVoice(filePath, voicePath);
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: voicePath },
                        ptt: true,
                        waveform: waveform,
                        seconds: await this.getAudioDuration(voicePath)
                    });
                    await fs.unlink(voicePath).catch(() => {});
                    break;
                case 'audio':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: filePath },
                        mimetype: mime.lookup(fileName) || 'audio/mp3',
                        fileName: fileName,
                        caption: caption
                    });
                    break;
                case 'document':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        document: { url: filePath },
                        fileName: fileName,
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        caption: caption
                    });
                    break;
                case 'sticker':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        sticker: { url: filePath }
                    });
                    break;
            }

            await fs.unlink(filePath).catch(() => {});
            await confirm.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
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
                    '-vf scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2'
                ])
                .on('end', resolve)
                .on('error', reject)
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
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    }

    async generateWaveform(audioPath) {
        try {
            const duration = await this.getAudioDuration(audioPath);
            const samples = Math.min(Math.floor(duration), 60);
            const waveform = [];

            for (let i = 0; i < samples; i++) {
                waveform.push(Math.floor(Math.random() * 100) + 1);
            }

            return Buffer.from(waveform);
        } catch (error) {
            return Buffer.from([50, 75, 25, 100, 60, 80, 40, 90, 30, 70]);
        }
    }

    async getAudioDuration(audioPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(audioPath, (err, metadata) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(Math.floor(metadata.format.duration || 0));
                }
            });
        });
    }

// WA → TG Reactions, About, View-Once, Utilities, Shutdown, Export

    async sendSimpleMessage(topicId, text, sender) {
        try {
            const chatId = config.get('telegram.chatId');
            const userInfo = this.userMappings.get(sender) || {};
            const name = userInfo.name || sender.split('@')[0];

            const msg = `💬 *${name}*:\n${text}`;
            const sent = await this.telegramBot.sendMessage(chatId, msg, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            return sent.message_id;
        } catch (error) {
            logger.error('❌ Failed to send simple text message:', error);
            return null;
        }
    }

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

            const message = `❤️ Reaction from *${name}*: \`${reaction.emoji}\``;
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

    async forwardViewOnceMedia(msg, topicId, filePath, caption) {
        try {
            const chatId = config.get('telegram.chatId');
            const opts = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown',
                has_spoiler: true
            };

            if (msg.imageMessage) {
                await this.telegramBot.sendPhoto(chatId, filePath, opts);
            } else if (msg.videoMessage) {
                await this.telegramBot.sendVideo(chatId, filePath, opts);
            }

            logger.debug('📸 Sent view-once media as spoiler');
        } catch (error) {
            logger.error('❌ Failed to send view-once media as spoiler:', error);
        }
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
//
