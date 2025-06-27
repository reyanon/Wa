const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const logger = require('../core/logger');

ffmpeg.setFfmpegPath(ffmpegStatic);

class TelegramMessageHandler {
    constructor(telegramBridge) {
        this.telegramBridge = telegramBridge;
        this.telegramBot = telegramBridge.telegramBot;
        this.whatsappBot = telegramBridge.whatsappBot;
        this.tempDir = telegramBridge.tempDir;
    }

    async initializeHandlers() {
        const bot = this.telegramBot;

        bot.on('message', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            if (msg.text) await this.handleText(msg);
        });

        bot.on('photo', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleMedia(msg, 'photo');
        });

        bot.on('video', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleMedia(msg, 'video');
        });

        bot.on('voice', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleMedia(msg, 'voice');
        });

        bot.on('audio', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleMedia(msg, 'audio');
        });

        bot.on('document', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleMedia(msg, 'document');
        });

        bot.on('sticker', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleMedia(msg, 'sticker');
        });

        bot.on('location', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleLocation(msg);
        });

        bot.on('contact', async (msg) => {
            if (msg.chat.type !== 'supergroup' || !msg.is_topic_message) return;
            await this.handleContact(msg);
        });

        bot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });
    }

    async handleText(msg) {
        const topicId = msg.message_thread_id;
        const jid = this.telegramBridge.findWhatsAppJidByTopic(topicId);
        if (!jid) return;

        try {
            await this.whatsappBot.sendMessage(jid, { text: msg.text });
            await this.confirmDelivery(msg);
        } catch (err) {
            logger.error('❌ Failed to send Telegram text to WA:', err);
            await this.confirmFailure(msg);
        }
    }

    async confirmDelivery(msg) {
        try {
            await this.telegramBot.sendMessage(msg.chat.id, '✅ Delivered', {
                reply_to_message_id: msg.message_id
            });
        } catch (err) {
            logger.debug('❌ Failed to send delivery confirmation:', err.message);
        }
    }

        async confirmFailure(msg) {
        try {
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to deliver', {
                reply_to_message_id: msg.message_id
            });
        } catch (err) {
            logger.debug('❌ Failed to send failure reply:', err.message);
        }
    }  // ✅ <--- this must exist

    async handleMedia(msg, mediaType) {
        const topicId = msg.message_thread_id;
        const jid = this.telegramBridge.findWhatsAppJidByTopic(topicId);
        if (!jid) return;

        try {
            const fileId = this.getFileId(msg, mediaType);
            const fileName = this.getFileName(msg, mediaType);
            const fileLink = await this.telegramBot.getFileLink(fileId);

            const buffer = await axios.get(fileLink, { responseType: 'arraybuffer' }).then(res => res.data);
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            switch (mediaType) {
                case 'photo':
                    await this.whatsappBot.sendMessage(jid, {
                        image: { url: filePath },
                        caption: msg.caption || ''
                    });
                    break;

                case 'video':
                    await this.whatsappBot.sendMessage(jid, {
                        video: { url: filePath },
                        caption: msg.caption || ''
                    });
                    break;

                case 'voice':
                    const voiceFile = path.join(this.tempDir, `voice_${Date.now()}.ogg`);
                    await this.convertToVoice(filePath, voiceFile);
                    await this.whatsappBot.sendMessage(jid, {
                        audio: { url: voiceFile },
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                        seconds: await this.getAudioDuration(voiceFile)
                    });
                    await fs.remove(voiceFile);
                    break;

                case 'audio':
                    await this.whatsappBot.sendMessage(jid, {
                        audio: { url: filePath },
                        mimetype: mime.lookup(fileName) || 'audio/mpeg',
                        fileName: fileName
                    });
                    break;

                case 'document':
                    await this.whatsappBot.sendMessage(jid, {
                        document: { url: filePath },
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        fileName: fileName
                    });
                    break;

                case 'sticker':
                    await this.whatsappBot.sendMessage(jid, {
                        sticker: { url: filePath }
                    });
                    break;
            }

            await fs.remove(filePath);
            await this.confirmDelivery(msg);
        } catch (err) {
            logger.error(`❌ Failed to handle media (${mediaType}):`, err);
            await this.confirmFailure(msg);
        }
    }

    getFileId(msg, mediaType) {
        if (mediaType === 'photo') return msg.photo.at(-1).file_id;
        return msg[mediaType]?.file_id;
    }

    getFileName(msg, mediaType) {
        switch (mediaType) {
            case 'photo': return `photo_${Date.now()}.jpg`;
            case 'video': return `video_${Date.now()}.mp4`;
            case 'voice': return `voice_${Date.now()}.ogg`;
            case 'audio': return msg.audio?.file_name || `audio_${Date.now()}.mp3`;
            case 'document': return msg.document?.file_name || `doc_${Date.now()}`;
            case 'sticker': return `sticker_${Date.now()}.webp`;
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

    async handleLocation(msg) {
        const topicId = msg.message_thread_id;
        const jid = this.telegramBridge.findWhatsAppJidByTopic(topicId);
        if (!jid) return;

        try {
            await this.whatsappBot.sendMessage(jid, {
                location: {
                    degreesLatitude: msg.location.latitude,
                    degreesLongitude: msg.location.longitude
                }
            });
            await this.confirmDelivery(msg);
        } catch (err) {
            logger.error('❌ Failed to send Telegram location to WA:', err);
            await this.confirmFailure(msg);
        }
    }

    async handleContact(msg) {
        const topicId = msg.message_thread_id;
        const jid = this.telegramBridge.findWhatsAppJidByTopic(topicId);
        if (!jid) return;

        try {
            const phone = msg.contact.phone_number;
            const name = msg.contact.first_name || phone;
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL:${phone}\nEND:VCARD`;

            await this.whatsappBot.sendMessage(jid, {
                contacts: {
                    displayName: name,
                    contacts: [{ vcard }]
                }
            });

            await this.confirmDelivery(msg);
        } catch (err) {
            logger.error('❌ Failed to send Telegram contact to WA:', err);
            await this.confirmFailure(msg);
        }
    }
    async shutdown() {
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Cleaned up Telegram temp directory');
        } catch (err) {
            logger.warn('⚠️ Temp cleanup failed:', err.message);
        }
    }
}

module.exports = TelegramMessageHandler;
