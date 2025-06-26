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
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.reverseChatMappings = new Map(); // Telegram Topic ID -> WhatsApp JID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.messageQueue = [];
        this.processingMessages = new Set(); // Prevent duplicate processing
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            // Ensure temp directory exists
            await fs.ensureDir(this.tempDir);
            
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle all types of messages
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle media messages specifically
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

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
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

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        const messageId = whatsappMsg.key.id;
        if (this.processingMessages.has(messageId)) return;
        this.processingMessages.add(messageId);

        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            // Create user mapping if not exists
            await this.createUserMapping(participant, whatsappMsg);
            
            // Get or create topic for this chat
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            
            // Handle different message types
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
            } else if (text) {
                // Send simple text message
                await this.sendSimpleMessage(topicId, text);
            }
        } finally {
            this.processingMessages.delete(messageId);
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        // Extract user info from WhatsApp
        let userName = null;
        let userPhone = participant.split('@')[0];
        
        try {
            // Try to get pushname from message first
            if (whatsappMsg.pushName) {
                userName = whatsappMsg.pushName;
            }
            
            // Try to get contact name from WhatsApp
            if (!userName && this.whatsappBot.sock) {
                try {
                    const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                    if (contact && contact[0] && contact[0].notify) {
                        userName = contact[0].notify;
                    }
                } catch (error) {
                    logger.debug('Could not fetch contact info:', error);
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
            const isCall = chatJid.includes('call') || chatJid === 'call@broadcast';
            
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
                    topicName = groupMeta.subject;
                } catch (error) {
                    topicName = `Group Chat`;
                }
                iconColor = 0x6FB9F0; // Blue
            } else {
                // For individual chats
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                const phone = participant.split('@')[0];
                
                if (userInfo && userInfo.name) {
                    topicName = `${userInfo.name} ${phone}`;
                } else {
                    topicName = phone;
                }
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            this.reverseChatMappings.set(topic.message_thread_id, chatJid);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send profile picture if it's a private chat
            if (!isGroup && !isStatus && !isCall) {
                await this.sendProfilePicture(topic.message_thread_id, chatJid, false);
            }
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendProfilePicture(topicId, jid, isUpdate = false) {
        try {
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            
            if (profilePicUrl && profilePicUrl !== this.profilePicCache.get(jid)) {
                const caption = isUpdate ? 'Profile picture updated' : null;
                
                await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
                    message_thread_id: topicId,
                    caption: caption
                });
                
                // Cache the profile pic URL
                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            
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

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to Telegram based on media type
            const chatId = config.get('telegram.chatId');
            
            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(chatId, filePath, {
                        message_thread_id: topicId
                    });
                    break;
                    
                case 'video':
                    await this.telegramBot.sendVideo(chatId, filePath, {
                        message_thread_id: topicId
                    });
                    break;
                    
                case 'audio':
                    if (mediaMessage.ptt) {
                        // Send as voice message
                        await this.telegramBot.sendVoice(chatId, filePath, {
                            message_thread_id: topicId
                        });
                    } else {
                        await this.telegramBot.sendAudio(chatId, filePath, {
                            message_thread_id: topicId
                        });
                    }
                    break;
                    
                case 'document':
                    await this.telegramBot.sendDocument(chatId, filePath, {
                        message_thread_id: topicId
                    });
                    break;
                    
                case 'sticker':
                    await this.telegramBot.sendSticker(chatId, filePath, {
                        message_thread_id: topicId
                    });
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
        }
    }

    async handleTelegramMessage(msg) {
        // Only handle text messages here, media is handled separately
        if (!msg.text || msg.photo || msg.video || msg.audio || msg.voice || msg.document || msg.sticker || msg.video_note) return;
        
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.reverseChatMappings.get(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            // Send to WhatsApp
            await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            
            // React with checkmark for confirmation
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '✅' }]);

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            // React with X for error
            try {
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
            } catch (reactionError) {
                logger.debug('Could not set error reaction:', reactionError);
            }
        }
    }

    async handleTelegramMedia(msg, mediaType) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.reverseChatMappings.get(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
                return;
            }

            let fileId, fileName, mimeType;
            
            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo[msg.photo.length - 1].file_id; // Get highest resolution
                    fileName = `photo_${Date.now()}.jpg`;
                    mimeType = 'image/jpeg';
                    break;
                case 'video':
                    fileId = msg.video.file_id;
                    fileName = `video_${Date.now()}.mp4`;
                    mimeType = msg.video.mime_type || 'video/mp4';
                    break;
                case 'video_note':
                    fileId = msg.video_note.file_id;
                    fileName = `video_note_${Date.now()}.mp4`;
                    mimeType = 'video/mp4';
                    break;
                case 'voice':
                    fileId = msg.voice.file_id;
                    fileName = `voice_${Date.now()}.ogg`;
                    mimeType = msg.voice.mime_type || 'audio/ogg';
                    break;
                case 'audio':
                    fileId = msg.audio.file_id;
                    fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
                    mimeType = msg.audio.mime_type || 'audio/mpeg';
                    break;
                case 'document':
                    fileId = msg.document.file_id;
                    fileName = msg.document.file_name || `document_${Date.now()}`;
                    mimeType = msg.document.mime_type || 'application/octet-stream';
                    break;
                case 'sticker':
                    fileId = msg.sticker.file_id;
                    fileName = `sticker_${Date.now()}.webp`;
                    mimeType = 'image/webp';
                    break;
            }

            // Download from Telegram
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to WhatsApp based on media type
            switch (mediaType) {
                case 'photo':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        image: { url: filePath },
                        mimetype: mimeType
                    });
                    break;
                    
                case 'video':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        video: { url: filePath },
                        mimetype: mimeType
                    });
                    break;
                    
                case 'video_note':
                    // Convert video note to WhatsApp PTV format
                    const ptvPath = path.join(this.tempDir, `ptv_${Date.now()}.mp4`);
                    await this.convertToPTV(filePath, ptvPath);
                    
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        video: { url: ptvPath },
                        ptv: true // Send as PTV (video note)
                    });
                    
                    await fs.unlink(ptvPath).catch(() => {});
                    break;
                    
                case 'voice':
                    // Convert to WhatsApp voice note format with proper encoding
                    const voicePath = path.join(this.tempDir, `voice_${Date.now()}.ogg`);
                    await this.convertToWhatsAppVoice(filePath, voicePath);
                    
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: voicePath },
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true, // Push to talk (voice note)
                        seconds: msg.voice.duration || 0
                    });
                    
                    await fs.unlink(voicePath).catch(() => {});
                    break;
                    
                case 'audio':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: filePath },
                        mimetype: mimeType
                    });
                    break;
                    
                case 'document':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        document: { url: filePath },
                        fileName: fileName,
                        mimetype: mimeType
                    });
                    break;
                    
                case 'sticker':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        sticker: { url: filePath }
                    });
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            // React with checkmark for confirmation
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '✅' }]);

        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            // React with X for error
            try {
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
            } catch (reactionError) {
                logger.debug('Could not set error reaction:', reactionError);
            }
        }
    }

    async convertToPTV(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .format('mp4')
                .size('320x320') // Square format for PTV
                .aspect('1:1')
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
                .audioBitrate('16k')
                .outputOptions([
                    '-avoid_negative_ts make_zero',
                    '-fflags +genpts'
                ])
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    }

    async sendSimpleMessage(topicId, text) {
        if (!topicId) return;

        const chatId = config.get('telegram.chatId');
        
        try {
            await this.telegramBot.sendMessage(chatId, text, {
                message_thread_id: topicId
            });
        } catch (error) {
            logger.error('❌ Failed to send message to Telegram:', error);
        }
    }

    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
            logger.info('📱 Telegram bridge stopped');
        }
        
        // Clean up temp directory
        try {
            await fs.emptyDir(this.tempDir);
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
    }
}

module.exports = TelegramBridge;
