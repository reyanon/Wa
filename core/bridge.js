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
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
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

        // Handle media messages
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



    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        // Extract user info from WhatsApp
        let userName = 'Name not available';
        let userPhone = participant.split('@')[0];
        
        try {
            // Try to get contact name from WhatsApp
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0] && contact[0].notify) {
                    userName = contact[0].notify;
                }
                
                // Try to get pushname from message
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

        logger.debug(`👤 Created user mapping: ${userName} (${userPhone})`);
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
            const isCall = chatJid.includes('call');
            
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
                // For individual chats
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                const phone = participant.split('@')[0];
                
                if (userInfo && userInfo.name !== 'Name not available') {
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
            
            if (profilePicUrl) {
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

async syncWhatsAppMessage(whatsappMsg) {
    try {
        if (!this.bot.sock?.ws?.readyState === 1) {
            logger.warn('WhatsApp connection not active, skipping message sync');
            return;
        }
        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        await this.updateUserMapping(participant, whatsappMsg);
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        if (!topicId) return;
        const message = whatsappMsg.message;
        let sentMessageId = null;
        if (message?.imageMessage && !this.config.skipImages) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (message?.videoMessage && !this.config.skipVideos) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (message?.audioMessage && !this.config.skipAudios) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (message?.documentMessage && !this.config.skipDocuments) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (message?.stickerMessage && !this.config.skipStickers) {
            sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (message?.locationMessage && !this.config.skipLocations) {
            sentMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if ((message?.contactMessage || message?.contactsArrayMessage) && !this.config.skipContacts) {
            sentMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else {
            const text = this.extractText(whatsappMsg);
            if (text) {
                sentMessageId = await this.sendSimpleMessage(topicId, text, sender, participant, whatsappMsg);
            }
        }
        if (sentMessageId && whatsappMsg.key.id) {
            this.messagePairs.set(sentMessageId, {
                whatsappId: whatsappMsg.key.id,
                whatsappJid: sender,
                telegramMessageId: sentMessageId,
                timestamp: new Date()
            });
            this.cleanMessagePairs();
        }
    } catch (error) {
        logger.error('❌ Error syncing WhatsApp message:', error);
    }
}

async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
    let filePath;
    try {
        let mediaMessage;
        let fileName = `media_${Date.now()}`;
        let caption = this.extractText(whatsappMsg);
        let mimetype;
        switch (mediaType) {
            case 'image':
                mediaMessage = whatsappMsg.message.imageMessage;
                fileName += '.jpg';
                mimetype = mediaMessage.mimetype || 'image/jpeg';
                break;
            case 'video':
                mediaMessage = whatsappMsg.message.videoMessage;
                fileName += '.mp4';
                mimetype = mediaMessage.mimetype || 'video/mp4';
                break;
            case 'audio':
                mediaMessage = whatsappMsg.message.audioMessage;
                fileName += mediaMessage.ptt ? '.ogg' : '.mp4';
                mimetype = mediaMessage.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4';
                break;
            case 'document':
                mediaMessage = whatsappMsg.message.documentMessage;
                fileName = mediaMessage.fileName || `document_${Date.now()}`;
                mimetype = mediaMessage.mimetype || 'application/octet-stream';
                break;
            case 'sticker':
                mediaMessage = whatsappMsg.message.stickerMessage;
                fileName += '.webp';
                mimetype = mediaMessage.isAnimated ? 'video/webm' : 'image/webp';
                break;
        }
        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        if (sender.endsWith('@g.us') && participant !== sender) {
            const userInfo = this.userMappings.get(participant);
            const name = userInfo?.name || participant.split('@')[0];
            caption = `👤 **${name}**: ${caption || ''}`;
        }
        if (mediaMessage.viewOnce && this.config.spoilerViewOnce) {
            caption = `🔒 **View Once Media**\n\n||${caption || ''}||`;
        }
        const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
        const buffer = await this.streamToBuffer(stream);
        const fileSizeMB = buffer.length / (1024 * 1024);
        const maxSizeMB = mediaType === 'document' ? 100 : mediaType === 'sticker' ? 5 : 16;
        if (fileSizeMB > maxSizeMB) {
            await this.telegramBot.sendMessage(this.config.chatId, 
                `❌ Media file too large (${fileSizeMB.toFixed(2)}MB). Max size: ${maxSizeMB}MB`, 
                { message_thread_id: topicId });
            return null;
        }
        filePath = path.join(this.tempDir, fileName);
        await fs.writeFile(filePath, buffer);
        let sentMessage;
        const options = {
            message_thread_id: topicId,
            caption: caption,
            parse_mode: 'Markdown',
            has_spoiler: mediaMessage.viewOnce && this.config.spoilerViewOnce
        };
        switch (mediaType) {
            case 'image':
                sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, filePath, options);
                break;
            case 'video':
                if (mediaMessage.gifPlayback) {
                    sentMessage = await this.telegramBot.sendAnimation(this.config.chatId, filePath, options);
                } else {
                    sentMessage = await this.telegramBot.sendVideo(this.config.chatId, filePath, options);
                }
                break;
            case 'audio':
                if (mediaMessage.ptt) {
                    sentMessage = await this.telegramBot.sendVoice(this.config.chatId, filePath, options);
                } else {
                    sentMessage = await this.telegramBot.sendAudio(this.config.chatId, filePath, options);
                }
                break;
            case 'document':
                sentMessage = await this.telegramBot.sendDocument(this.config.chatId, filePath, options);
                break;
            case 'sticker':
                try {
                    sentMessage = await this.telegramBot.sendSticker(this.config.chatId, filePath, {
                        message_thread_id: topicId
                    });
                } catch (stickerError) {
                    logger.debug('Failed to send sticker, sending as photo:', stickerError);
                    sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, filePath, {
                        message_thread_id: topicId,
                        caption: caption || 'Sticker',
                        parse_mode: 'Markdown'
                    });
                }
                break;
        }
        return sentMessage?.message_id;
    } catch (error) {
        logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
        await this.telegramBot.sendMessage(this.config.chatId, 
            `❌ Failed to send ${mediaType}: ${error.message}`, 
            { message_thread_id: topicId });
        return null;
    } finally {
        if (filePath) {
            try {
                await fs.unlink(filePath);
            } catch (error) {
                logger.debug(`Failed to delete temp file ${filePath}:`, error);
            }
        }
    }
}


    async handleTelegramMessage(msg) {
        // Only handle text messages here, media is handled separately
        if (!msg.text) return;
        
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
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
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
                return;
            }

            let fileId, fileName;
            
            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo[msg.photo.length - 1].file_id; // Get highest resolution
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
                        image: { url: filePath }
                    });
                    break;
                    
                case 'video':
                case 'video_note':
                    if (mediaType === 'video_note') {
                        // Convert video note to regular video for WhatsApp
                        const convertedPath = path.join(this.tempDir, `converted_${fileName}`);
                        await this.convertVideoNote(filePath, convertedPath);
                        
                        await this.whatsappBot.sendMessage(whatsappJid, {
                            video: { url: convertedPath },
                            ptv: true // Send as PTV (video note)
                        });
                        
                        await fs.unlink(convertedPath).catch(() => {});
                    } else {
                        await this.whatsappBot.sendMessage(whatsappJid, {
                            video: { url: filePath }
                        });
                    }
                    break;
                    
                case 'voice':
                    // Convert OGG to proper format for WhatsApp voice note
                    const voicePath = path.join(this.tempDir, `voice_${Date.now()}.ogg`);
                    await this.convertToWhatsAppVoice(filePath, voicePath);
                    
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: voicePath },
                        ptt: true // Push to talk (voice note)
                    });
                    
                    await fs.unlink(voicePath).catch(() => {});
                    break;
                    
                case 'audio':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: filePath }
                    });
                    break;
                    
                case 'document':
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        document: { url: filePath },
                        fileName: fileName,
                        mimetype: mime.lookup(fileName) || 'application/octet-stream'
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

    async convertVideoNote(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .format('mp4')
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

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
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
