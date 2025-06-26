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
            // Only process messages from supergroups if topics are enabled, and ensure it's a topic message.
            // If useTopics is false, it's a regular supergroup without topics.
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle media messages specifically
        this.telegramBot.on('photo', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'photo');
            }
        });

        this.telegramBot.on('video', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'video');
            }
        });

        this.telegramBot.on('video_note', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'video_note');
            }
        });

        this.telegramBot.on('voice', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'voice');
            }
        });

        this.telegramBot.on('audio', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'audio');
            }
        });

        this.telegramBot.on('document', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'document');
            }
        });

        this.telegramBot.on('sticker', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramMedia(msg, 'sticker');
            }
        });

        this.telegramBot.on('location', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramLocation(msg);
            }
        });

        this.telegramBot.on('contact', async (msg) => {
            if (msg.chat.type === 'supergroup' && 
               ((config.get('telegram.useTopics') && msg.is_topic_message) || !config.get('telegram.useTopics'))) {
                await this.handleTelegramContact(msg);
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
        if (!logChannel || logChannel.includes('2345678901')) { // Check for placeholder or invalid
            logger.debug('Telegram log channel not configured');
            return;
        }

        try {
            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            // If logging to a topic-enabled group, log to the general topic 0
            const threadId = config.get('telegram.useTopics') ? 0 : undefined;

            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown',
                message_thread_id: threadId // Only set if using topics
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        if (!topicId) {
            logger.warn(`Could not determine Telegram topic for WhatsApp JID: ${sender}`);
            return;
        }

        // Handle different message types
        if (whatsappMsg.message?.imageMessage && config.get('telegram.settings.allowMedia')) {
            await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage && config.get('telegram.settings.allowVideos')) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage && (config.get('telegram.settings.allowVoice') || config.get('telegram.settings.allowAudio'))) {
            await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage && config.get('telegram.settings.allowDocuments')) {
            await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage && config.get('telegram.settings.allowStickers')) {
            await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage) { 
            await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.contactMessage && config.get('telegram.settings.syncContacts')) { 
            await this.handleWhatsAppContact(whatsappMsg, topicId);
        }
        else if (text) {
            // Send text message
            await this.sendSimpleMessage(topicId, text);
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
            logger.debug('Could not fetch contact info for user mapping:', error);
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
        if (!config.get('telegram.useTopics')) {
            // If topics are not used, always return the main chatId
            return config.get('telegram.chatId');
        }

        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId || typeof chatId !== 'string' || !chatId.startsWith('-100')) {
            logger.error('❌ Telegram chat ID not configured properly or is not a supergroup ID');
            return null;
        }

        try {
            const isGroup = chatJid.endsWith('@g.us');
            const isStatus = chatJid === 'status@broadcast';
            const isCall = chatJid.includes('call'); // General check for call JIDs
            
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
                    // Attempt to send group profile picture when topic is created
                    if (config.get('telegram.settings.autoUpdateProfilePics')) {
                        await this.sendProfilePicture(null, chatJid, false); // topicId is set after creation
                    }
                } catch (error) {
                    topicName = `Group Chat ${chatJid.split('@')[0]}`;
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
            
            // Send profile picture if it's a private chat, now with the actual topic ID
            if (!isGroup && !isStatus && !isCall && config.get('telegram.settings.autoUpdateProfilePics')) {
                await this.sendProfilePicture(topic.message_thread_id, chatJid, false);
            }
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            // If topic creation fails, fall back to main chat ID if topics are optional or problem occurs.
            // However, since useTopics is true, we should indicate failure if it doesn't work.
            return null;
        }
    }

    async sendProfilePicture(topicId, jid, isUpdate = false) {
        if (!config.get('telegram.settings.autoUpdateProfilePics')) return;

        try {
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            
            // Ensure topicId is correctly set if topics are enabled
            const finalTopicId = config.get('telegram.useTopics') ? (topicId || this.chatMappings.get(jid)) : undefined;

            if (profilePicUrl && profilePicUrl !== this.profilePicCache.get(jid)) { // Only send if new/changed
                const caption = isUpdate ? 'Profile picture updated' : null;
                
                await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
                    message_thread_id: finalTopicId,
                    caption: caption
                });
                
                // Cache the profile pic URL
                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error.message);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            let caption = this.extractText(whatsappMsg); // Extract caption if available
            
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
                    fileName += '.webp'; // WhatsApp stickers are typically WebP
                    break;
                default:
                    return; // Unknown media type
            }

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Determine message_thread_id based on useTopics config
            const finalTopicId = config.get('telegram.useTopics') ? topicId : undefined;

            // Send to Telegram based on media type
            const chatId = config.get('telegram.chatId');
            
            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(chatId, filePath, {
                        message_thread_id: finalTopicId,
                        caption: caption
                    });
                    break;
                    
                case 'video':
                    await this.telegramBot.sendVideo(chatId, filePath, {
                        message_thread_id: finalTopicId,
                        caption: caption,
                        supports_streaming: true // For faster playback
                    });
                    break;
                    
                case 'audio':
                    if (mediaMessage.ptt) {
                        // Send as voice message if it's a WhatsApp voice note
                        await this.telegramBot.sendVoice(chatId, filePath, {
                            message_thread_id: finalTopicId,
                            caption: caption
                        });
                    } else {
                        // Otherwise, send as a regular audio file
                        await this.telegramBot.sendAudio(chatId, filePath, {
                            message_thread_id: finalTopicId,
                            caption: caption
                        });
                    }
                    break;
                    
                case 'document':
                    await this.telegramBot.sendDocument(chatId, filePath, {
                        message_thread_id: finalTopicId,
                        caption: caption,
                        fileName: fileName // Ensure filename is passed
                    });
                    break;
                    
                case 'sticker':
                    // Check if it's an animated WebP (WhatsApp animated sticker)
                    const isAnimatedWebP = buffer.slice(0, 12).toString('ascii').includes('ANIM');
                    
                    if (!isAnimatedWebP) {
                        // For static WebP stickers, attempt to send as a Telegram sticker.
                        try {
                            await this.telegramBot.sendSticker(chatId, filePath, {
                                message_thread_id: finalTopicId
                            });
                        } catch (stickerError) {
                            logger.warn(`Failed to send WhatsApp static sticker as Telegram sticker (${stickerError.message}), falling back to photo.`);
                            // Fallback: Convert to PNG and send as photo if direct sticker send fails
                            const pngPath = filePath.replace('.webp', '.png');
                            await sharp(filePath).png().toFile(pngPath);
                            await this.telegramBot.sendPhoto(chatId, pngPath, {
                                message_thread_id: finalTopicId,
                                caption: caption
                            });
                            await fs.unlink(pngPath).catch(() => {});
                        }
                    } else {
                        // For animated WebP (WhatsApp animated sticker), convert to MP4 video.
                        const videoPath = filePath.replace('.webp', '.mp4');
                        try {
                            await new Promise((resolve, reject) => {
                                ffmpeg(filePath)
                                    .toFormat('mp4')
                                    .videoCodec('libx264')
                                    .outputOptions([
                                        '-movflags +faststart',
                                        '-pix_fmt yuv420p',
                                        '-vf scale=512:-1', // Scale width to 512, maintain aspect ratio
                                        '-crf 28' // Good balance of quality and file size
                                    ])
                                    .on('end', resolve)
                                    .on('error', reject)
                                    .save(videoPath);
                            });
                            await this.telegramBot.sendVideo(chatId, videoPath, {
                                message_thread_id: finalTopicId,
                                caption: (caption ? caption + '\n' : '') + ' [Animated Sticker]',
                                supports_streaming: true
                            });
                            await fs.unlink(videoPath).catch(() => {});
                        } catch (videoConvertError) {
                            logger.warn(`Failed to convert animated WebP to video (${videoConvertError.message}), sending as document.`);
                            await this.telegramBot.sendDocument(chatId, filePath, {
                                message_thread_id: finalTopicId,
                                caption: (caption ? caption + '\n' : '') + 'Animated sticker (animation not preserved)',
                                filename: fileName
                            });
                        }
                    }
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const locationMessage = whatsappMsg.message.locationMessage;
            const finalTopicId = config.get('telegram.useTopics') ? topicId : undefined;

            await this.telegramBot.sendLocation(config.get('telegram.chatId'), 
                locationMessage.degreesLatitude, 
                locationMessage.degreesLongitude, {
                    message_thread_id: finalTopicId,
                    title: locationMessage.name || locationMessage.address,
                    address: locationMessage.address
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
            const finalTopicId = config.get('telegram.useTopics') ? topicId : undefined;

            await this.telegramBot.sendDocument(config.get('telegram.chatId'), Buffer.from(vcard), {
                message_thread_id: finalTopicId,
                caption: `Contact: ${displayName}`,
                fileName: `${displayName}.vcf`,
                mimetype: 'text/vcard'
            });
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
        }
    }

    async handleTelegramMessage(msg) {
        // If the message contains any media, it should have been handled by specific media listeners.
        // This prevents captions of media from being re-sent as text messages.
        if (msg.photo || msg.video || msg.video_note || msg.voice || msg.audio || msg.document || msg.sticker || msg.location || msg.contact) {
            return; // Media message, do not process as text here
        }

        if (!msg.text) return; // Only process text if no media is present
        
        try {
            const topicId = config.get('telegram.useTopics') ? msg.message_thread_id : undefined;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId); // Pass topicId to findWhatsAppJidByTopic

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                // React with X if no WhatsApp JID can be found
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
                return;
            }

            // Send to WhatsApp
            await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            
            // Re-enabled: Confirmation reaction
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
            const topicId = config.get('telegram.useTopics') ? msg.message_thread_id : undefined;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
                // React with X if no WhatsApp JID can be found
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
                return;
            }

            let fileId, fileName, caption = msg.caption || '';
            
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
                    // For animated stickers (.tgs), Telegram will send a WebP representation to download
                    // If it's a regular WebP sticker, it will be handled as such.
                    // WhatsApp doesn't directly support .tgs, so we convert.
                    if (msg.sticker.is_animated || msg.sticker.is_video) {
                        fileName = `sticker_${Date.now()}.mp4`; // Convert animated/video sticker to MP4
                    } else {
                        fileName = `sticker_${Date.now()}.webp`;
                    }
                    break;
                default:
                    logger.warn(`Unsupported media type from Telegram: ${mediaType}`);
                    await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
                    return;
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
                        caption: caption
                    });
                    break;
                    
                case 'video':
                case 'video_note':
                    // Video notes from Telegram are typically handled as PTV (play-then-view) on WhatsApp
                    if (mediaType === 'video_note') {
                        const convertedPath = path.join(this.tempDir, `converted_video_note_${Date.now()}.mp4`);
                        await this.convertVideoNote(filePath, convertedPath);
                        
                        await this.whatsappBot.sendMessage(whatsappJid, {
                            video: { url: convertedPath },
                            ptv: true, // Send as PTV (video note)
                            caption: caption
                        });
                        
                        await fs.unlink(convertedPath).catch(() => {});
                    } else {
                        await this.whatsappBot.sendMessage(whatsappJid, {
                            video: { url: filePath },
                            caption: caption
                        });
                    }
                    break;
                    
                case 'voice':
                    // Convert OGG to proper format for WhatsApp voice note (mimicking mic recording)
                    const voicePath = path.join(this.tempDir, `voice_whatsapp_${Date.now()}.ogg`);
                    await this.convertToWhatsAppVoice(filePath, voicePath);
                    
                    await this.whatsappBot.sendMessage(whatsappJid, {
                        audio: { url: voicePath },
                        ptt: true // Push to talk (voice note)
                    });
                    
                    await fs.unlink(voicePath).catch(() => {});
                    break;
                    
                case 'audio':
                    // For general audio, send as a regular audio file
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
                    if (msg.sticker.is_animated || msg.sticker.is_video) {
                        // Convert animated/video sticker (.tgs) to MP4 for WhatsApp
                        const convertedVideoPath = path.join(this.tempDir, `converted_sticker_${Date.now()}.mp4`);
                        await this.convertAnimatedStickerToVideo(filePath, convertedVideoPath);

                        await this.whatsappBot.sendMessage(whatsappJid, {
                            video: { url: convertedVideoPath },
                            gifPlayback: true, // Attempt to play as GIF
                            caption: (caption ? caption + '\n' : '') + ' [Animated Sticker]'
                        });
                        await fs.unlink(convertedVideoPath).catch(() => {});
                    } else {
                        // Send static WebP sticker directly
                        await this.whatsappBot.sendMessage(whatsappJid, {
                            sticker: { url: filePath }
                        });
                    }
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            // Re-enabled: Confirmation reaction
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

    async handleTelegramLocation(msg) {
        try {
            const topicId = config.get('telegram.useTopics') ? msg.message_thread_id : undefined;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
                return;
            }

            await this.whatsappBot.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude,
                    name: msg.location.title, // Use title for name
                    address: msg.location.address // Use address for address
                } 
            });

            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '✅' }]);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
        }
    }

    async handleTelegramContact(msg) {
        try {
            const topicId = config.get('telegram.useTopics') ? msg.message_thread_id : undefined;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram contact');
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
                return;
            }

            // Construct a simple VCard string from Telegram contact data
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

            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '✅' }]);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: '❌' }]);
        }
    }


    async convertVideoNote(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .format('mp4')
                .outputOptions('-movflags +faststart') // Optimize for web streaming
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
                .audioBitrate('24k') // Optimized bitrate for WhatsApp voice notes
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    }

    async convertAnimatedStickerToVideo(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoCodec('libx264')
                .outputOptions([
                    '-pix_fmt yuv420p', // Pixel format for broader compatibility
                    '-vf scale=512:-1', // Scale to a reasonable size (e.g., 512px width)
                    '-crf 28', // Constant Rate Factor for quality-controlled compression
                    '-preset veryfast' // Faster encoding
                ])
                .toFormat('mp4')
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
        });
    }

    async sendSimpleMessage(topicId, text) {
        // Ensure topicId is correctly set if useTopics is false
        const finalTopicId = config.get('telegram.useTopics') ? topicId : undefined;

        const chatId = config.get('telegram.chatId');
        
        try {
            await this.telegramBot.sendMessage(chatId, text, {
                message_thread_id: finalTopicId
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
        // If topics are not used, always return the main chat JID.
        if (!config.get('telegram.useTopics')) {
            // This is a simplification; you'd need a way to map the Telegram chat ID
            // back to *the* WhatsApp JID you're actively bridging.
            // For a single bridged chat, you might store it, or if it's a broadcast
            // group where all WhatsApp messages go to one Telegram chat, this works.
            // For one-to-one bridging, you'd need a reverse map for the main chat ID.
            // For now, assuming direct mapping via chatMappings or a fixed JID if no topics.
            for (const [jid, mappedTopic] of this.chatMappings.entries()) {
                // If mapping to a single chat, the mappedTopic would be the main chatId.
                if (mappedTopic === config.get('telegram.chatId') && topicId === undefined) {
                    return jid;
                }
            }
            // If no explicit mapping and no topics, this can be ambiguous.
            // You might need a default WhatsApp JID if the bot only bridges one chat.
            return null; 
        }

        // If topics are used, look up by topicId
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    // Helper to extract text from whatsapp message for captions
    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               '';
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        // Ensure the log channel is configured before attempting to log
        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('2345678901')) {
            logger.warn('Skipping Telegram connection log: logChannel not configured properly.');
            return;
        }

        await this.logToTelegram('🚀 WhatsApp Bot Started', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        if (this.telegramBot) {
            // It's good practice to stop polling explicitly
            // However, node-telegram-bot-api's stopPolling might not be strictly necessary for clean exit
            // as it's often handled internally on process exit or when the instance is garbage collected.
            // But if you want to be explicit:
            // this.telegramBot.stopPolling();
            logger.info('📱 Telegram bot polling stopped.');
        }
        
        // Clean up temp directory
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
