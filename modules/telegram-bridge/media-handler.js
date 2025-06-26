const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const logger = require('../../core/logger');

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

class MediaHandler {
    constructor(telegramBridge) {
        this.bridge = telegramBridge;
        this.tempDir = path.join(__dirname, '../../temp');
        this.maxFileSize = 50 * 1024 * 1024; // 50MB
        this.supportedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        this.supportedVideoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/mkv'];
        this.supportedAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/m4a'];
    }

    async initialize() {
        // Ensure temp directory exists
        await fs.ensureDir(this.tempDir);
        logger.info('🎥 Media Handler initialized');
    }

    async processWhatsAppMedia(whatsappMsg, messageContent) {
        try {
            const messageType = Object.keys(whatsappMsg.message)[0];
            const mediaMessage = whatsappMsg.message[messageType];
            
            if (!this.bridge.isMediaTypeAllowed(messageType.replace('Message', ''))) {
                logger.debug(`Media type ${messageType} not allowed`);
                return null;
            }

            // Download media from WhatsApp
            const mediaData = await this.downloadWhatsAppMedia(whatsappMsg, messageType);
            if (!mediaData) return null;

            // Process and send to Telegram
            await this.sendMediaToTelegram(mediaData, messageContent, whatsappMsg);
            
            // Cleanup temp file
            await this.cleanupTempFile(mediaData.filePath);
            
        } catch (error) {
            logger.error('Failed to process WhatsApp media:', error);
        }
    }

    async downloadWhatsAppMedia(whatsappMsg, messageType) {
        try {
            const whatsappBot = this.bridge.getWhatsAppBot();
            const mediaMessage = whatsappMsg.message[messageType];
            
            // Download media buffer
            const buffer = await whatsappBot.sock.downloadMediaMessage(whatsappMsg);
            if (!buffer) return null;

            // Check file size
            if (buffer.length > this.maxFileSize) {
                logger.warn('Media file too large:', buffer.length);
                return null;
            }

            // Determine file extension and MIME type
            const mimeType = mediaMessage.mimetype || 'application/octet-stream';
            const extension = mime.extension(mimeType) || 'bin';
            
            // Create temp file
            const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${extension}`;
            const filePath = path.join(this.tempDir, fileName);
            
            await fs.writeFile(filePath, buffer);
            
            return {
                filePath,
                fileName,
                mimeType,
                messageType,
                size: buffer.length,
                caption: mediaMessage.caption || ''
            };
            
        } catch (error) {
            logger.error('Failed to download WhatsApp media:', error);
            return null;
        }
    }

    async sendMediaToTelegram(mediaData, messageContent, whatsappMsg) {
        try {
            const telegramBot = this.bridge.getTelegramBot();
            const targetChatId = this.bridge.getTargetChatId();
            
            if (!telegramBot || !targetChatId) return;

            // Get topic ID
            const chatMapping = await this.bridge.getDatabase().getChatMapping(whatsappMsg.key.remoteJid);
            if (!chatMapping) return;

            // Format caption with sender info
            const senderInfo = await this.bridge.contactManager.getContactInfo(
                whatsappMsg.key.participant || whatsappMsg.key.remoteJid
            );
            
            const caption = `👤 *${senderInfo.name}*\n` +
                          `📱 ${senderInfo.phone}\n` +
                          `📅 ${new Date().toLocaleString()}\n\n` +
                          `${mediaData.caption || messageContent || ''}`;

            // Send based on media type
            await this.sendMediaByType(mediaData, caption, targetChatId, chatMapping.telegramTopicId);
            
        } catch (error) {
            logger.error('Failed to send media to Telegram:', error);
        }
    }

    async sendMediaByType(mediaData, caption, chatId, topicId) {
        const telegramBot = this.bridge.getTelegramBot();
        const options = {
            caption: caption.substring(0, 1024), // Telegram caption limit
            parse_mode: 'Markdown',
            message_thread_id: topicId
        };

        try {
            switch (mediaData.messageType) {
                case 'imageMessage':
                    if (this.supportedImageTypes.includes(mediaData.mimeType)) {
                        await telegramBot.sendPhoto(chatId, mediaData.filePath, options);
                    } else {
                        await telegramBot.sendDocument(chatId, mediaData.filePath, options);
                    }
                    break;

                case 'videoMessage':
                    if (this.supportedVideoTypes.includes(mediaData.mimeType)) {
                        // Compress video if too large
                        const compressedPath = await this.compressVideo(mediaData.filePath);
                        await telegramBot.sendVideo(chatId, compressedPath, options);
                        if (compressedPath !== mediaData.filePath) {
                            await this.cleanupTempFile(compressedPath);
                        }
                    } else {
                        await telegramBot.sendDocument(chatId, mediaData.filePath, options);
                    }
                    break;

                case 'audioMessage':
                case 'pttMessage': // Voice message
                    if (mediaData.messageType === 'pttMessage') {
                        await telegramBot.sendVoice(chatId, mediaData.filePath, options);
                    } else {
                        await telegramBot.sendAudio(chatId, mediaData.filePath, options);
                    }
                    break;

                case 'documentMessage':
                    options.caption = `📄 *Document*\n${caption}`;
                    await telegramBot.sendDocument(chatId, mediaData.filePath, options);
                    break;

                case 'stickerMessage':
                    // Convert sticker to image if needed
                    const stickerPath = await this.convertStickerToImage(mediaData.filePath);
                    await telegramBot.sendPhoto(chatId, stickerPath, {
                        ...options,
                        caption: `🏷️ *Sticker*\n${caption}`
                    });
                    if (stickerPath !== mediaData.filePath) {
                        await this.cleanupTempFile(stickerPath);
                    }
                    break;

                default:
                    await telegramBot.sendDocument(chatId, mediaData.filePath, options);
            }
        } catch (error) {
            logger.error(`Failed to send ${mediaData.messageType}:`, error);
            // Fallback to document
            try {
                await telegramBot.sendDocument(chatId, mediaData.filePath, {
                    caption: `❌ *Media Error*\n${caption}`,
                    parse_mode: 'Markdown',
                    message_thread_id: topicId
                });
            } catch (fallbackError) {
                logger.error('Fallback send also failed:', fallbackError);
            }
        }
    }

    async processTelegramMedia(msg, chatData) {
        try {
            let mediaData = null;
            let messageType = '';

            // Determine media type and get file info
            if (msg.photo) {
                const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
                mediaData = await this.downloadTelegramMedia(photo.file_id);
                messageType = 'image';
            } else if (msg.video) {
                mediaData = await this.downloadTelegramMedia(msg.video.file_id);
                messageType = 'video';
            } else if (msg.video_note) {
                mediaData = await this.downloadTelegramMedia(msg.video_note.file_id);
                messageType = 'video_note';
            } else if (msg.voice) {
                mediaData = await this.downloadTelegramMedia(msg.voice.file_id);
                messageType = 'voice';
            } else if (msg.audio) {
                mediaData = await this.downloadTelegramMedia(msg.audio.file_id);
                messageType = 'audio';
            } else if (msg.document) {
                mediaData = await this.downloadTelegramMedia(msg.document.file_id);
                messageType = 'document';
            } else if (msg.sticker) {
                mediaData = await this.downloadTelegramMedia(msg.sticker.file_id);
                messageType = 'sticker';
            }

            if (!mediaData) return;

            // Send to WhatsApp
            await this.sendMediaToWhatsApp(mediaData, messageType, msg, chatData);
            
            // Cleanup
            await this.cleanupTempFile(mediaData.filePath);
            
        } catch (error) {
            logger.error('Failed to process Telegram media:', error);
        }
    }

    async downloadTelegramMedia(fileId) {
        try {
            const telegramBot = this.bridge.getTelegramBot();
            const file = await telegramBot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${this.bridge.getTelegramBot().token}/${file.file_path}`;
            
            // Download file
            const response = await axios({
                method: 'get',
                url: fileUrl,
                responseType: 'stream'
            });

            // Save to temp file
            const fileName = `telegram_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const filePath = path.join(this.tempDir, fileName);
            
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            return {
                filePath,
                fileName,
                size: (await fs.stat(filePath)).size
            };
            
        } catch (error) {
            logger.error('Failed to download Telegram media:', error);
            return null;
        }
    }

    async sendMediaToWhatsApp(mediaData, messageType, telegramMsg, chatData) {
        try {
            const whatsappBot = this.bridge.getWhatsAppBot();
            const caption = telegramMsg.caption || '📤 From Telegram';
            
            let whatsappMessage = {};

            switch (messageType) {
                case 'image':
                    whatsappMessage = {
                        image: { url: mediaData.filePath },
                        caption: caption
                    };
                    break;

                case 'video':
                    whatsappMessage = {
                        video: { url: mediaData.filePath },
                        caption: caption
                    };
                    break;

                case 'video_note':
                    // Convert video note to regular video
                    whatsappMessage = {
                        video: { url: mediaData.filePath },
                        caption: '🎥 Video Note\n' + caption
                    };
                    break;

                case 'voice':
                    whatsappMessage = {
                        audio: { url: mediaData.filePath },
                        ptt: true, // Send as voice message
                        caption: caption
                    };
                    break;

                case 'audio':
                    whatsappMessage = {
                        audio: { url: mediaData.filePath },
                        caption: caption
                    };
                    break;

                case 'document':
                    whatsappMessage = {
                        document: { url: mediaData.filePath },
                        caption: caption,
                        fileName: telegramMsg.document?.file_name || 'document'
                    };
                    break;

                case 'sticker':
                    // Convert sticker to image
                    const stickerPath = await this.convertStickerToImage(mediaData.filePath);
                    whatsappMessage = {
                        image: { url: stickerPath },
                        caption: '🏷️ Sticker\n' + caption
                    };
                    if (stickerPath !== mediaData.filePath) {
                        setTimeout(() => this.cleanupTempFile(stickerPath), 5000);
                    }
                    break;

                default:
                    whatsappMessage = {
                        document: { url: mediaData.filePath },
                        caption: caption
                    };
            }

            await whatsappBot.sendMessage(chatData.whatsappJid, whatsappMessage);
            
        } catch (error) {
            logger.error('Failed to send media to WhatsApp:', error);
        }
    }

    async compressVideo(inputPath) {
        try {
            const outputPath = inputPath + '_compressed.mp4';
            
            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .size('?x720') // Max height 720p
                    .videoBitrate('1000k')
                    .audioBitrate('128k')
                    .output(outputPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            // Check if compression was successful and file is smaller
            const originalSize = (await fs.stat(inputPath)).size;
            const compressedSize = (await fs.stat(outputPath)).size;
            
            if (compressedSize < originalSize) {
                return outputPath;
            } else {
                await this.cleanupTempFile(outputPath);
                return inputPath;
            }
            
        } catch (error) {
            logger.error('Video compression failed:', error);
            return inputPath;
        }
    }

    async convertStickerToImage(stickerPath) {
        try {
            const outputPath = stickerPath + '_converted.png';
            
            await sharp(stickerPath)
                .png()
                .resize(512, 512, { fit: 'inside' })
                .toFile(outputPath);
                
            return outputPath;
            
        } catch (error) {
            logger.error('Sticker conversion failed:', error);
            return stickerPath;
        }
    }

    async cleanupTempFile(filePath) {
        try {
            if (await fs.pathExists(filePath)) {
                await fs.unlink(filePath);
            }
        } catch (error) {
            logger.debug('Failed to cleanup temp file:', error);
        }
    }

    async cleanupTempFiles() {
        try {
            const files = await fs.readdir(this.tempDir);
            const now = Date.now();
            const maxAge = 24 * 60 * 60 * 1000; // 24 hours

            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                const stats = await fs.stat(filePath);
                
                if (now - stats.mtime.getTime() > maxAge) {
                    await fs.unlink(filePath);
                }
            }
        } catch (error) {
            logger.error('Failed to cleanup temp files:', error);
        }
    }
}

module.exports = MediaHandler;
