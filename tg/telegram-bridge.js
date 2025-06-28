const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('../config');
const logger = require('../core/logger');

// Set ffmpeg path if available
if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

class TelegramBridge {
    constructor(bot) {
        this.bot = bot;
        this.name = 'telegram-bridge';
        this.version = '1.12.3'; // Updated version
        this.description = 'Enhanced Telegram Bridge for WhatsApp Bot';
        
        // Core properties
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.messagePairs = new Map(); // WhatsApp Message ID -> Telegram Message ID
        this.userMappings = new Map(); // WhatsApp User -> Contact Info
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map();
        this.statusMessageIds = new Map();
        this.ephemeralSettings = new Map(); // Chat -> ephemeral settings
        this.unreadMessages = new Map(); // Chat -> unread message IDs
        this.callHistory = new Map(); // Track call history
        
        // Configuration
        this.config = {
            botToken: config.get('telegram.botToken'),
            chatId: config.get('telegram.chatId'),
            logChannel: config.get('telegram.logChannel'),
            enabled: config.get('telegram.enabled', false),
            ownerIds: config.get('telegram.ownerIds', []),
            sudoUsers: config.get('telegram.sudoUsers', []),
            skipVideoStickers: config.get('telegram.skipVideoStickers', false),
            sendPresence: config.get('telegram.sendPresence', true),
            sendReadReceipts: config.get('telegram.sendReadReceipts', true),
            silentConfirmation: config.get('telegram.silentConfirmation', false),
            confirmationType: config.get('telegram.confirmationType', 'emoji'),
            spoilerViewOnce: config.get('telegram.spoilerViewOnce', true),
            reactions: config.get('telegram.reactions', true),
            skipStartupMessage: config.get('telegram.skipStartupMessage', false),
            skipDocuments: config.get('telegram.skipDocuments', false),
            skipImages: config.get('telegram.skipImages', false),
            skipVideos: config.get('telegram.skipVideos', false),
            skipAudios: config.get('telegram.skipAudios', false),
            skipStickers: config.get('telegram.skipStickers', false),
            skipContacts: config.get('telegram.skipContacts', false),
            skipLocations: config.get('telegram.skipLocations', false),
            skipStatus: config.get('telegram.skipStatus', false),
            sendMyPresence: config.get('telegram.sendMyPresence', true),
            sendMyReadReceipts: config.get('telegram.sendMyReadReceipts', true)
        };

        // Commands (merged and updated)
        this.commands = [
            {
                name: 'tgstart',
                description: 'Start Telegram bridge',
                usage: 'tgstart',
                execute: this.handleStartCommand.bind(this)
            },
            {
                name: 'tgstatus',
                description: 'Show Telegram bridge status',
                usage: 'tgstatus',
                execute: this.handleStatusCommand.bind(this)
            },
            {
                name: 'tgstop',
                description: 'Stop Telegram bridge',
                usage: 'tgstop',
                execute: this.handleStopCommand.bind(this)
            },
            {
                name: 'tghelp',
                description: 'Show Telegram bridge help',
                usage: 'tghelp',
                execute: this.handleHelpCommand.bind(this)
            },
            {
                name: 'tgbridge',
                description: 'Manage Telegram bridge settings',
                usage: 'tgbridge <start|stop|status|config>',
                execute: this.handleTgBridgeCommand.bind(this)
            },
            {
                name: 'tgblock',
                description: 'Block a user in WhatsApp',
                usage: 'tgblock (in topic)',
                execute: this.handleBlockCommand.bind(this)
            },
            {
                name: 'tgunblock',
                description: 'Unblock a user in WhatsApp',
                usage: 'tgunblock (in topic)',
                execute: this.handleUnblockCommand.bind(this)
            },
            {
                name: 'tggroups',
                description: 'Get all WhatsApp groups with their JIDs',
                usage: 'tggroups',
                execute: this.handleGetGroupsCommand.bind(this)
            },
            {
                name: 'tgfind',
                description: 'Fuzzy find contact JIDs from names',
                usage: 'tgfind <search_string>',
                execute: this.handleFindContactCommand.bind(this)
            },
            {
                name: 'tgrevoke',
                description: 'Revoke a message from WhatsApp',
                usage: 'tgrevoke (reply to message)',
                execute: this.handleRevokeCommand.bind(this)
            },
            {
                name: 'tgsync',
                description: 'Sync contacts list from WhatsApp',
                usage: 'tgsync',
                execute: this.handleSyncContactsCommand.bind(this)
            },
            {
                name: 'tgclear',
                description: 'Delete all stored message ID pairs',
                usage: 'tgclear',
                execute: this.handleClearHistoryCommand.bind(this)
            },
            {
                name: 'tgrestart',
                description: 'Restart WhatsApp connection',
                usage: 'tgrestart',
                execute: this.handleRestartWACommand.bind(this)
            },
            {
                name: 'tgjoin',
                description: 'Join WhatsApp group using invite link',
                usage: 'tgjoin <invite_link>',
                execute: this.handleJoinGroupCommand.bind(this)
            },
            {
                name: 'tgsetgroup',
                description: 'Set target WhatsApp group for current thread',
                usage: 'tgsetgroup <group_id>',
                execute: this.handleSetTargetGroupCommand.bind(this)
            },
            {
                name: 'tgsetprivate',
                description: 'Set target WhatsApp private chat for current thread',
                usage: 'tgsetprivate <user_id>',
                execute: this.handleSetTargetPrivateCommand.bind(this)
            },
            {
                name: 'tgunlink',
                description: 'Unlink current thread from WhatsApp chat',
                usage: 'tgunlink',
                execute: this.handleUnlinkThreadCommand.bind(this)
            },
            {
                name: 'tgpic',
                description: 'Get profile picture of user or group',
                usage: 'tgpic <user/group_id>',
                execute: this.handleGetProfilePictureCommand.bind(this)
            },
            {
                name: 'tgtopics',
                description: 'Update names of created topics',
                usage: 'tgtopics',
                execute: this.handleSyncTopicNamesCommand.bind(this)
            },
            {
                name: 'tgsend',
                description: 'Send message to WhatsApp',
                usage: 'tgsend <target_id> (reply to message)',
                execute: this.handleSendCommand.bind(this)
            }
        ];

        // Message hooks
        this.messageHooks = {
            'whatsapp_connected': this.onWhatsAppConnected.bind(this),
            'message_received': this.onMessageReceived.bind(this),
            'status_received': this.onStatusReceived.bind(this),
            'call_received': this.onCallReceived.bind(this),
            'group_participants_update': this.onGroupParticipantsUpdate.bind(this),
            'group_update': this.onGroupUpdate.bind(this),
            'presence_update': this.onPresenceUpdate.bind(this),
            'message_revoked': this.onMessageRevoked.bind(this),
            'message_reaction': this.onMessageReaction.bind(this),
            'message_delivery': this.onMessageDelivery.bind(this)
        };

        this.startTime = new Date();
        this.stats = {
            messagesForwarded: 0,
            mediaForwarded: 0,
            commandsExecuted: 0,
            topicsCreated: 0,
            callsLogged: 0,
            reactionsHandled: 0,
            errors: 0,
            deliveryUpdates: 0
        };
    }

    async init() {
        logger.info('🔧 Initializing Enhanced Telegram Bridge module...');
        
        await fs.ensureDir(this.tempDir);
        
        if (this.config.enabled && this.isProperlyConfigured()) {
            await this.initializeTelegramBot();
        } else {
            logger.warn('⚠️ Telegram bridge not started - check configuration');
        }
        
        logger.info('✅ Enhanced Telegram Bridge module initialized');
    }

    isProperlyConfigured() {
        return !!(this.config.botToken && this.config.chatId);
    }

    async initializeTelegramBot() {
        try {
            this.telegramBot = new TelegramBot(this.config.botToken, { polling: true });
            
            // Set up Telegram event handlers
            this.telegramBot.on('message', this.handleTelegramMessage.bind(this));
            this.telegramBot.on('callback_query', this.handleCallbackQuery.bind(this));
            this.telegramBot.on('error', (error) => {
                logger.error('Telegram Bot Error:', error);
                this.stats.errors++;
            });
            this.telegramBot.on('polling_error', (error) => {
                logger.error('Telegram Polling Error:', error);
                this.stats.errors++;
            });

            // Set Telegram bot commands
            const botCommands = this.commands.map(cmd => ({
                command: cmd.name,
                description: cmd.description
            }));
            await this.telegramBot.setMyCommands(botCommands);

            logger.info('✅ Telegram Bot initialized');
        } catch (error) {
            logger.error('Failed to initialize Telegram Bot:', error);
            this.stats.errors++;
        }
    }

    async handleTelegramMessage(msg) {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            const chatId = msg.chat.id.toString();
            const topicId = msg.message_thread_id?.toString();
            const waJid = this.getWhatsAppJidFromTopic(topicId);

            // Handle commands
            if (msg.text && msg.text.startsWith('/')) {
                const [commandName, ...args] = msg.text.slice(1).split(' ');
                const command = this.commands.find(cmd => cmd.name === commandName);
                
                if (command) {
                    await command.execute({ msg, args, chatId, topicId });
                    this.stats.commandsExecuted++;
                    return;
                }
            }

            // Handle regular messages
            if (waJid) {
                await this.forwardTelegramToWhatsApp(msg, waJid);
            } else {
                await this.telegramBot.sendMessage(chatId, '⚠️ This thread is not linked to any WhatsApp chat. Use /tgsetgroup or /tgsetprivate to link it.');
            }
        } catch (error) {
            logger.error('Error handling Telegram message:', error);
            this.stats.errors++;
            await this.telegramBot.sendMessage(msg.chat.id, '❌ An error occurred while processing your message.');
        } finally {
            this.isProcessing = false;
        }
    }

    async forwardTelegramToWhatsApp(msg, waJid) {
        try {
            let content = {};
            let caption = msg.text || msg.caption || '';

            // Remove bot handle from text
            if (caption && this.telegramBot) {
                const botUsername = (await this.telegramBot.getMe()).username;
                caption = caption.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '');
            }

            // Handle spoiler (hidden) messages
            if (msg.spoiler || (msg.has_media_spoiler && this.config.spoilerViewOnce)) {
                content.viewOnce = true;
            }

            // Handle different message types
            if (msg.text) {
                content.text = caption;
            } else if (msg.photo) {
                if (!this.config.skipImages) {
                    const fileId = msg.photo[msg.photo.length - 1].file_id;
                    const file = await this.downloadTelegramFile(fileId);
                    const metadata = await sharp(file).metadata();
                    content.image = { url: file };
                    content.caption = caption;
                    content.mimetype = 'image/jpeg';
                    content.viewOnce = msg.has_media_spoiler || content.viewOnce;
                    content.metadata = {
                        width: metadata.width,
                        height: metadata.height,
                        size: metadata.size
                    };
                }
            } else if (msg.video || msg.video_note) {
                if (!this.config.skipVideos) {
                    const fileId = msg.video?.file_id || msg.video_note?.file_id;
                    const file = await this.downloadTelegramFile(fileId);
                    const isVideoNote = !!msg.video_note;
                    let processedFile = file;

                    if (isVideoNote) {
                        // Convert video note to WhatsApp-compatible format
                        processedFile = await this.convertVideoNote(file);
                    }

                    const metadata = await this.getVideoMetadata(processedFile);
                    content.video = { url: processedFile };
                    content.caption = caption;
                    content.mimetype = isVideoNote ? 'video/mp4' : mime.lookup(file) || 'video/mp4';
                    content.viewOnce = msg.has_media_spoiler || content.viewOnce;
                    content.metadata = {
                        duration: metadata.duration,
                        width: metadata.width,
                        height: metadata.height,
                        size: metadata.size
                    };
                }
            } else if (msg.audio) {
                if (!this.config.skipAudios) {
                    const fileId = msg.audio.file_id;
                    const file = await this.downloadTelegramFile(fileId);
                    const metadata = await this.getAudioMetadata(file);
                    content.audio = { url: file };
                    content.caption = caption;
                    content.mimetype = msg.audio.mime_type || 'audio/mpeg';
                    content.metadata = {
                        duration: metadata.duration,
                        size: metadata.size
                    };
                }
            } else if (msg.document) {
                if (!this.config.skipDocuments) {
                    const fileId = msg.document.file_id;
                    const file = await this.downloadTelegramFile(fileId);
                    content.document = { url: file };
                    content.caption = caption;
                    content.mimetype = msg.document.mime_type || mime.lookup(msg.document.file_name) || 'application/octet-stream';
                    content.fileName = msg.document.file_name;
                    content.metadata = { size: msg.document.file_size };
                }
            } else if (msg.sticker && !this.config.skipStickers) {
                const fileId = msg.sticker.file_id;
                const file = await this.downloadTelegramFile(fileId);
                content.sticker = { url: file };
                content.mimetype = msg.sticker.is_animated ? 'image/gif' : 'image/webp';
            } else if (msg.location && !this.config.skipLocations) {
                content.location = {
                    latitude: msg.location.latitude,
                    longitude: msg.location.longitude
                };
                content.caption = caption;
            } else if (msg.contact && !this.config.skipContacts) {
                content.contact = {
                    vcard: this.formatVCard(msg.contact)
                };
            }

            if (Object.keys(content).length > 0) {
                const sentMessage = await this.bot.sock.sendMessage(waJid, content);
                if (sentMessage) {
                    this.messagePairs.set(sentMessage.key.id, msg.message_id);
                    this.stats.messagesForwarded++;
                    if (content.image || content.video || content.audio || content.document || content.sticker) {
                        this.stats.mediaForwarded++;
                    }

                    // Send delivery confirmation
                    if (this.config.sendReadReceipts && this.config.confirmationType === 'emoji') {
                        await this.telegramBot.sendMessage(msg.chat.id, '✅', {
                            message_thread_id: msg.message_thread_id,
                            reply_to_message_id: msg.message_id
                        });
                    }
                }
            }
        } catch (error) {
            logger.error(`Error forwarding Telegram message to WhatsApp (${waJid}):`, error);
            this.stats.errors++;
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to send message to WhatsApp.', {
                message_thread_id: msg.message_thread_id
            });
        }
    }

    async downloadTelegramFile(fileId) {
        const filePath = await this.telegramBot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${filePath.file_path}`;
        const fileName = path.join(this.tempDir, `${fileId}_${Date.now()}${path.extname(filePath.file_path) || ''}`);
        
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        await fs.writeFile(fileName, response.data);
        return fileName;
    }

    async convertVideoNote(inputPath) {
        const outputPath = path.join(this.tempDir, `converted_${Date.now()}.mp4`);
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-c:v libx264',
                    '-c:a aac',
                    '-vf scale=640:640',
                    '-r 30',
                    '-b:v 1000k'
                ])
                .output(outputPath)
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .run();
        });
    }

    async getVideoMetadata(filePath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) return reject(err);
                const stream = metadata.streams.find(s => s.codec_type === 'video') || {};
                resolve({
                    duration: metadata.format.duration || 0,
                    width: stream.width || 0,
                    height: stream.height || 0,
                    size: metadata.format.size || 0
                });
            });
        });
    }

    async getAudioMetadata(filePath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) return reject(err);
                resolve({
                    duration: metadata.format.duration || 0,
                    size: metadata.format.size || 0
                });
            });
        });
    }

    formatVCard(contact) {
        return `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.first_name || ''} ${contact.last_name || ''}\nTEL;TYPE=CELL:${contact.phone_number}\nEND:VCARD`;
    }

    getWhatsAppJidFromTopic(topicId) {
        for (const [jid, mappedTopicId] of this.chatMappings.entries()) {
            if (mappedTopicId === topicId) {
                return jid;
            }
        }
        return null;
    }

    async createTelegramTopic(jid, name) {
        try {
            const topic = await this.telegramBot.createForumTopic(this.config.chatId, name);
            this.chatMappings.set(jid, topic.message_thread_id.toString());
            this.stats.topicsCreated++;

            // Send and pin a welcome message
            const welcomeMessage = await this.telegramBot.sendMessage(this.config.chatId, 
                `📌 Linked to WhatsApp chat: ${name}`, 
                { message_thread_id: topic.message_thread_id }
            );
            await this.telegramBot.pinChatMessage(this.config.chatId, welcomeMessage.message_id, {
                message_thread_id: topic.message_thread_id
            });

            return topic.message_thread_id;
        } catch (error) {
            logger.error(`Error creating Telegram topic for ${jid}:`, error);
            this.stats.errors++;
            return null;
        }
    }

    async onWhatsAppConnected() {
        try {
            if (this.telegramBot && this.config.logChannel) {
                await this.telegramBot.sendMessage(this.config.logChannel, 
                    '✅ WhatsApp connection established!');
            }
        } catch (error) {
            logger.error('Error in onWhatsAppConnected:', error);
            this.stats.errors++;
        }
    }

    async onMessageReceived(message) {
        if (!this.telegramBot || !this.config.enabled) return;

        try {
            const { key, message: msgContent } = message;
            const jid = key.remoteJid;
            let topicId = this.chatMappings.get(jid);

            if (!topicId) {
                const chatName = await this.getChatName(jid);
                topicId = await this.createTelegramTopic(jid, chatName);
            }

            if (!topicId) return;

            let content = {};
            let caption = '';

            // Handle view-once messages as spoilers
            const isViewOnce = msgContent?.viewOnceMessageV2 || msgContent?.viewOnceMessage;

            // Remove bot handle from text
            if (msgContent?.conversation) {
                caption = msgContent.conversation;
                const botUsername = (await this.telegramBot.getMe()).username;
                caption = caption.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '');
                content.text = caption;
            } else if (msgContent?.extendedTextMessage) {
                caption = msgContent.extendedTextMessage.text;
                const botUsername = (await this.telegramBot.getMe()).username;
                caption = caption.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '');
                content.text = caption;
            } else if (msgContent?.imageMessage) {
                if (!this.config.skipImages) {
                    const buffer = await downloadContentFromMessage(msgContent.imageMessage, 'image');
                    const filePath = await this.saveTempFile(buffer, '.jpeg');
                    const metadata = await sharp(filePath).metadata();
                    content.photo = filePath;
                    caption = msgContent.imageMessage.caption || '';
                    content.has_spoiler = isViewOnce && this.config.spoilerViewOnce;
                    content.caption = caption;
                    content.metadata = {
                        width: metadata.width,
                        height: metadata.height,
                        size: metadata.size
                    };
                }
            } else if (msgContent?.videoMessage) {
                if (!this.config.skipVideos) {
                    const isVideoNote = msgContent.videoMessage?.seconds <= 60 && !msgContent.videoMessage.caption;
                    const buffer = await downloadContentFromMessage(msgContent.videoMessage, 'video');
                    let filePath = await this.saveTempFile(buffer, '.mp4');
                    
                    if (isVideoNote) {
                        filePath = await this.convertVideoNote(filePath);
                    }
                    
                    const metadata = await this.getVideoMetadata(filePath);
                    content[isVideoNote ? 'video_note' : 'video'] = filePath;
                    caption = msgContent.videoMessage.caption || '';
                    content.has_spoiler = isViewOnce && this.config.spoilerViewOnce;
                    content.caption = caption;
                    content.metadata = {
                        duration: metadata.duration,
                        width: metadata.width,
                        height: metadata.height,
                        size: metadata.size
                    };
                }
            } else if (msgContent?.audioMessage) {
                if (!this.config.skipAudios) {
                    const buffer = await downloadContentFromMessage(msgContent.audioMessage, 'audio');
                    const filePath = await this.saveTempFile(buffer, '.mp3');
                    const metadata = await this.getAudioMetadata(filePath);
                    content.audio = filePath;
                    content.caption = caption;
                    content.metadata = {
                        duration: metadata.duration,
                        size: metadata.size
                    };
                }
            } else if (msgContent?.documentMessage) {
                if (!this.config.skipDocuments) {
                    const buffer = await downloadContentFromMessage(msgContent.documentMessage, 'document');
                    const filePath = await this.saveTempFile(buffer, msgContent.documentMessage.fileName || '.bin');
                    content.document = filePath;
                    content.caption = msgContent.documentMessage.caption || '';
                    content.file_name = msgContent.documentMessage.fileName;
                    content.metadata = { size: msgContent.documentMessage.fileLength };
                }
            } else if (msgContent?.stickerMessage && !this.config.skipStickers) {
                const buffer = await downloadContentFromMessage(msgContent.stickerMessage, 'sticker');
                const filePath = await this.saveTempFile(buffer, msgContent.stickerMessage.isAnimated ? '.gif' : '.webp');
                content.sticker = filePath;
            } else if (msgContent?.locationMessage && !this.config.skipLocations) {
                content.location = {
                    latitude: msgContent.locationMessage.degreesLatitude,
                    longitude: msgContent.locationMessage.degreesLongitude
                };
                content.caption = msgContent.locationMessage.name || '';
            } else if (msgContent?.contactMessage && !this.config.skipContacts) {
                content.contact = {
                    vcard: msgContent.contactMessage.vcard
                };
            }

            if (Object.keys(content).length > 0) {
                const sender = await this.getSenderName(key.participant || jid);
                const formattedCaption = caption ? `${sender}: ${caption}` : sender;
                
                const options = {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown',
                    has_spoiler: content.has_spoiler || false
                };

                let sentMessage;
                if (content.text) {
                    sentMessage = await this.telegramBot.sendMessage(this.config.chatId, content.text, options);
                } else if (content.photo) {
                    options.caption = formattedCaption;
                    sentMessage = await this.telegramBot.sendPhoto(this.config.chatId, content.photo, options);
                } else if (content.video) {
                    options.caption = formattedCaption;
                    sentMessage = await this.telegramBot.sendVideo(this.config.chatId, content.video, options);
                } else if (content.video_note) {
                    sentMessage = await this.telegramBot.sendVideoNote(this.config.chatId, content.video_note, options);
                } else if (content.audio) {
                    options.caption = formattedCaption;
                    sentMessage = await this.telegramBot.sendAudio(this.config.chatId, content.audio, options);
                } else if (content.document) {
                    options.caption = formattedCaption;
                    sentMessage = await this.telegramBot.sendDocument(this.config.chatId, content.document, options);
                } else if (content.sticker) {
                    sentMessage = await this.telegramBot.sendSticker(this.config.chatId, content.sticker, options);
                } else if (content.location) {
                    options.caption = formattedCaption;
                    sentMessage = await this.telegramBot.sendLocation(this.config.chatId, content.location.latitude, content.location.longitude, options);
                } else if (content.contact) {
                    sentMessage = await this.telegramBot.sendContact(this.config.chatId, content.contact.vcard.split('TEL;TYPE=CELL:')[1].split('\n')[0], content.contact.vcard.split('FN:')[1].split('\n')[0], options);
                }

                if (sentMessage) {
                    this.messagePairs.set(key.id, sentMessage.message_id);
                    this.stats.messagesForwarded++;
                    if (content.photo || content.video || content.video_note || content.audio || content.document || content.sticker) {
                        this.stats.mediaForwarded++;
                    }

                    // Clean up temp file
                    if (content.photo || content.video || content.video_note || content.audio || content.document || content.sticker) {
                        await fs.unlink(content.photo || content.video || content.video_note || content.audio || content.document || content.sticker);
                    }
                }
            }
        } catch (error) {
            logger.error(`Error processing WhatsApp message (${jid}):`, error);
            this.stats.errors++;
        }
    }

    async onMessageDelivery(update) {
        if (!this.telegramBot || !this.config.enabled || !this.config.reactions) return;

        try {
            const { key, update: status } = update;
            const telegramMsgId = this.messagePairs.get(key.id);
            const topicId = this.chatMappings.get(key.remoteJid);

            if (!telegramMsgId || !topicId) return;

            let reaction = '';
            if (status.status === 'read') {
                reaction = '👀';
            } else if (status.status === 'delivered') {
                reaction = '✅';
            }

            if (reaction) {
                await this.telegramBot.sendMessage(this.config.chatId, reaction, {
                    message_thread_id: topicId,
                    reply_to_message_id: telegramMsgId
                });
                this.stats.deliveryUpdates++;
            }
        } catch (error) {
            logger.error('Error handling message delivery update:', error);
            this.stats.errors++;
        }
    }

    async onStatusReceived(status) {
        if (!this.telegramBot || !this.config.enabled || this.config.skipStatus) return;

        try {
            const { key, message } = status;
            const jid = key.remoteJid;
            let topicId = this.chatMappings.get(jid);

            if (!topicId) {
                const chatName = await this.getChatName(jid);
                topicId = await this.createTelegramTopic(jid, chatName);
            }

            if (message?.statusMessage) {
                const text = message.statusMessage.text || 'New status update';
                const sentMessage = await this.telegramBot.sendMessage(this.config.chatId, `📢 Status from ${jid}: ${text}`, {
                    message_thread_id: topicId
                });
                this.statusMessageIds.set(key.id, sentMessage.message_id);
                this.stats.messagesForwarded++;
            }
        } catch (error) {
            logger.error('Error handling status update:', error);
            this.stats.errors++;
        }
    }

    async onCallReceived(call) {
        if (!this.telegramBot || !this.config.enabled) return;

        try {
            const { from, id, timestamp, isGroupCall } = call;
            const callInfo = `📞 ${isGroupCall ? 'Group' : 'Private'} Call from ${from} at ${new Date(timestamp).toLocaleString()}`;
            const topicId = this.chatMappings.get(from) || this.config.logChannel;

            if (topicId) {
                await this.telegramBot.sendMessage(this.config.chatId, callInfo, {
                    message_thread_id: topicId
                });
                this.activeCallNotifications.set(id, callInfo);
                this.callHistory.set(id, call);
                this.stats.callsLogged++;
            }
        } catch (error) {
            logger.error('Error handling call:', error);
            this.stats.errors++;
        }
    }

    async onGroupParticipantsUpdate(update) {
        if (!this.telegramBot || !this.config.enabled) return;

        try {
            const { id, participants, action } = update;
            const topicId = this.chatMappings.get(id);
            if (!topicId) return;

            const actionText = {
                'add': 'joined',
                'remove': 'left',
                'promote': 'promoted to admin',
                'demote': 'demoted from admin'
            }[action] || action;

            const message = `👥 Group Update: ${participants.join(', ')} ${actionText}`;
            await this.telegramBot.sendMessage(this.config.chatId, message, {
                message_thread_id: topicId
            });
        } catch (error) {
            logger.error('Error handling group participants update:', error);
            this.stats.errors++;
        }
    }

    async onGroupUpdate(update) {
        if (!this.telegramBot || !this.config.enabled) return;

        try {
            const { id, subject } = update;
            const topicId = this.chatMappings.get(id);
            if (!topicId) return;

            await this.telegramBot.editForumTopic(this.config.chatId, topicId, { name: subject });
            await this.telegramBot.sendMessage(this.config.chatId, `🏷️ Group name updated to: ${subject}`, {
                message_thread_id: topicId
            });
        } catch (error) {
            logger.error('Error handling group update:', error);
            this.stats.errors++;
        }
    }

    async onPresenceUpdate(update) {
        if (!this.telegramBot || !this.config.enabled || !this.config.sendPresence) return;

        try {
            const { id, presences } = update;
            const topicId = this.chatMappings.get(id);
            if (!topicId) return;

            for (const [user, presence] of Object.entries(presences)) {
                const status = presence.lastKnownPresence === 'unavailable' ? 'offline' : presence.lastKnownPresence;
                await this.telegramBot.sendMessage(this.config.chatId, `👤 ${user} is now ${status}`, {
                    message_thread_id: topicId
                });
            }
        } catch (error) {
            logger.error('Error handling presence update:', error);
            this.stats.errors++;
        }
    }

    async onMessageRevoked(update) {
        if (!this.telegramBot || !this.config.enabled) return;

        try {
            const { key } = update;
            const telegramMsgId = this.messagePairs.get(key.id);
            const topicId = this.chatMappings.get(key.remoteJid);

            if (telegramMsgId && topicId) {
                await this.telegramBot.deleteMessage(this.config.chatId, telegramMsgId);
                this.messagePairs.delete(key.id);
            }
        } catch (error) {
            logger.error('Error handling message revoke:', error);
            this.stats.errors++;
        }
    }

    async onMessageReaction(reaction) {
        if (!this.telegramBot || !this.config.enabled || !this.config.reactions) return;

        try {
            const { key, reaction: reactionContent } = reaction;
            const telegramMsgId = this.messagePairs.get(key.id);
            const topicId = this.chatMappings.get(key.remoteJid);

            if (telegramMsgId && topicId) {
                await this.telegramBot.sendMessage(this.config.chatId, `😺 Reaction: ${reactionContent.text || '👍'} from ${key.participant || key.remoteJid}`, {
                    message_thread_id: topicId,
                    reply_to_message_id: telegramMsgId
                });
                this.stats.reactionsHandled++;
            }
        } catch (error) {
            logger.error('Error handling message reaction:', error);
            this.stats.errors++;
        }
    }

    async handleStartCommand({ msg, chatId }) {
        try {
            if (!this.config.enabled) {
                this.config.enabled = true;
                await this.initializeTelegramBot();
                await this.telegramBot.sendMessage(chatId, '✅ Telegram Bridge started!');
            } else {
                await this.telegramBot.sendMessage(chatId, 'ℹ️ Telegram Bridge is already running.');
            }
        } catch (error) {
            logger.error('Error in start command:', error);
            this.stats.errors++;
        }
    }

    async handleStatusCommand({ msg, chatId }) {
        try {
            const status = `📊 Telegram Bridge Status\n\n` +
                           `Version: ${this.version}\n` +
                           `Enabled: ${this.config.enabled ? '✅' : '❌'}\n` +
                           `Messages Forwarded: ${this.stats.messagesForwarded}\n` +
                           `Media Forwarded: ${this.stats.mediaForwarded}\n` +
                           `Commands Executed: ${this.stats.commandsExecuted}\n` +
                           `Topics Created: ${this.stats.topicsCreated}\n` +
                           `Calls Logged: ${this.stats.callsLogged}\n` +
                           `Reactions Handled: ${this.stats.reactionsHandled}\n` +
                           `Delivery Updates: ${this.stats.deliveryUpdates}\n` +
                           `Errors: ${this.stats.errors}\n` +
                           `Uptime: ${this.getUptime()}`;
            await this.telegramBot.sendMessage(chatId, status);
        } catch (error) {
            logger.error('Error in status command:', error);
            this.stats.errors++;
        }
    }

    async handleStopCommand({ msg, chatId }) {
        try {
            if (this.config.enabled) {
                this.config.enabled = false;
                if (this.telegramBot) {
                    await this.telegramBot.stopPolling();
                    this.telegramBot = null;
                }
                await this.telegramBot.sendMessage(chatId, '🛑 Telegram Bridge stopped.');
            } else {
                await this.telegramBot.sendMessage(chatId, 'ℹ️ Telegram Bridge is already stopped.');
            }
        } catch (error) {
            logger.error('Error in stop command:', error);
            this.stats.errors++;
        }
    }

    async handleHelpCommand({ msg, chatId }) {
        try {
            const helpText = this.commands.map(cmd => `/${cmd.name} - ${cmd.description}\nUsage: ${cmd.usage}`).join('\n');
            await this.telegramBot.sendMessage(chatId, `📚 Telegram Bridge Commands:\n\n${helpText}`);
        } catch (error) {
            logger.error('Error in help command:', error);
            this.stats.errors++;
        }
    }

    async handleTgBridgeCommand({ msg, args, chatId }) {
        try {
            const subcommand = args[0]?.toLowerCase();
            if (!subcommand) {
                await this.telegramBot.sendMessage(chatId, 'Usage: /tgbridge <start|stop|status|config>');
                return;
            }

            if (subcommand === 'start') {
                await this.handleStartCommand({ msg, chatId });
            } else if (subcommand === 'stop') {
                await this.handleStopCommand({ msg, chatId });
            } else if (subcommand === 'status') {
                await this.handleStatusCommand({ msg, chatId });
            } else if (subcommand === 'config') {
                const configText = JSON.stringify(this.config, null, 2);
                await this.telegramBot.sendMessage(chatId, `⚙️ Current Configuration:\n\`\`\`\n${configText}\n\`\`\``, { parse_mode: 'Markdown' });
            } else {
                await this.telegramBot.sendMessage(chatId, 'Invalid subcommand. Use: start, stop, status, or config.');
            }
        } catch (error) {
            logger.error('Error in tgbridge command:', error);
            this.stats.errors++;
        }
    }

    async handleBlockCommand({ msg, topicId }) {
        try {
            const waJid = this.getWhatsAppJidFromTopic(topicId);
            if (!waJid) {
                await this.telegramBot.sendMessage(msg.chat.id, '⚠️ This thread is not linked to a WhatsApp chat.', { message_thread_id: topicId });
                return;
            }

            await this.bot.sock.updateBlockStatus(waJid, 'block');
            await this.telegramBot.sendMessage(msg.chat.id, `✅ Blocked ${waJid}`, { message_thread_id: topicId });
        } catch (error) {
            logger.error('Error in block command:', error);
            this.stats.errors++;
        }
    }

    async handleUnblockCommand({ msg, topicId }) {
        try {
            const waJid = this.getWhatsAppJidFromTopic(topicId);
            if (!waJid) {
                await this.telegramBot.sendMessage(msg.chat.id, '⚠️ This thread is not linked to a WhatsApp chat.', { message_thread_id: topicId });
                return;
            }

            await this.bot.sock.updateBlockStatus(waJid, 'unblock');
            await this.telegramBot.sendMessage(msg.chat.id, `✅ Unblocked ${waJid}`, { message_thread_id: topicId });
        } catch (error) {
            logger.error('Error in unblock command:', error);
            this.stats.errors++;
        }
    }

    async handleGetGroupsCommand({ msg, chatId }) {
        try {
            const groups = await this.bot.sock.groupFetchAllParticipating();
            const groupList = Object.values(groups).map(g => `${g.subject} (${g.id})`).join('\n');
            await this.telegramBot.sendMessage(chatId, `📋 WhatsApp Groups:\n${groupList || 'No groups found.'}`);
        } catch (error) {
            logger.error('Error in getgroups command:', error);
            this.stats.errors++;
        }
    }

    async handleFindContactCommand({ msg, args, chatId }) {
        try {
            const search = args.join(' ').toLowerCase();
            const contacts = Array.from(this.userMappings.entries()).filter(([_, info]) => 
                info.name?.toLowerCase().includes(search)
            );
            const contactList = contacts.map(([jid, info]) => `${info.name} (${jid})`).join('\n');
            await this.telegramBot.sendMessage(chatId, `🔍 Found Contacts:\n${contactList || 'No contacts found.'}`);
        } catch (error) {
            logger.error('Error in findcontact command:', error);
            this.stats.errors++;
        }
    }

    async handleRevokeCommand({ msg, topicId }) {
        try {
            const waJid = this.getWhatsAppJidFromTopic(topicId);
            if (!waJid || !msg.reply_to_message) {
                await this.telegramBot.sendMessage(msg.chat.id, '⚠️ Reply to a message in a linked thread to revoke.', { message_thread_id: topicId });
                return;
            }

            const telegramMsgId = msg.reply_to_message.message_id;
            const waMsgId = Array.from(this.messagePairs.entries()).find(([_, tgId]) => tgId === telegramMsgId)?.[0];
            
            if (waMsgId) {
                await this.bot.sock.sendMessage(waJid, { delete: { id: waMsgId, remoteJid: waJid } });
                await this.telegramBot.deleteMessage(msg.chat.id, telegramMsgId);
                this.messagePairs.delete(waMsgId);
                await this.telegramBot.sendMessage(msg.chat.id, '✅ Message revoked.', { message_thread_id: topicId });
            }
        } catch (error) {
            logger.error('Error in revoke command:', error);
            this.stats.errors++;
        }
    }

    async handleSyncContactsCommand({ msg, chatId }) {
        try {
            const contacts = await this.bot.sock.contacts();
            this.userMappings.clear();
            for (const [jid, info] of Object.entries(contacts)) {
                this.userMappings.set(jid, info);
            }
            await this.telegramBot.sendMessage(chatId, `✅ Synced ${this.userMappings.size} contacts.`);
        } catch (error) {
            logger.error('Error in synccontacts command:', error);
            this.stats.errors++;
        }
    }

    async handleClearHistoryCommand({ msg, chatId }) {
        try {
            const count = this.messagePairs.size;
            this.messagePairs.clear();
            await this.telegramBot.sendMessage(chatId, `🧹 Cleared ${count} message pairs.`);
        } catch (error) {
            logger.error('Error in clearhistory command:', error);
            this.stats.errors++;
        }
    }

    async handleRestartWACommand({ msg, chatId }) {
        try {
            await this.bot.shutdown();
            await this.bot.startWhatsApp();
            await this.telegramBot.sendMessage(chatId, '🔄 WhatsApp connection restarted.');
        } catch (error) {
            logger.error('Error in restartwa command:', error);
            this.stats.errors++;
        }
    }

    async handleJoinGroupCommand({ msg, args, chatId }) {
        try {
            const inviteLink = args[0];
            if (!inviteLink) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Please provide a WhatsApp group invite link.');
                return;
            }

            const code = inviteLink.split('https://chat.whatsapp.com/')[1];
            const result = await this.bot.sock.groupAcceptInvite(code);
            await this.telegramBot.sendMessage(chatId, `✅ Joined group: ${result}`);
        } catch (error) {
            logger.error('Error in joingroup command:', error);
            this.stats.errors++;
        }
    }

    async handleSetTargetGroupCommand({ msg, args, chatId, topicId }) {
        try {
            const groupId = args[0];
            if (!groupId) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Please provide a group JID.', { message_thread_id: topicId });
                return;
            }

            const groups = await this.bot.sock.groupFetchAllParticipating();
            if (!groups[groupId]) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Invalid group JID.', { message_thread_id: topicId });
                return;
            }

            this.chatMappings.set(groupId, topicId);
            await this.telegramBot.sendMessage(chatId, `✅ Linked thread to group: ${groupId}`, { message_thread_id: topicId });
        } catch (error) {
            logger.error('Error in setgroup command:', error);
            this.stats.errors++;
        }
    }

    async handleSetTargetPrivateCommand({ msg, args, chatId, topicId }) {
        try {
            const userId = args[0];
            if (!userId) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Please provide a user JID.', { message_thread_id: topicId });
                return;
            }

            this.chatMappings.set(userId, topicId);
            await this.telegramBot.sendMessage(chatId, `✅ Linked thread to private chat: ${userId}`, { message_thread_id: topicId });
        } catch (error) {
            logger.error('Error in setprivate command:', error);
            this.stats.errors++;
        }
    }

    async handleUnlinkThreadCommand({ msg, topicId, chatId }) {
        try {
            const waJid = this.getWhatsAppJidFromTopic(topicId);
            if (waJid) {
                this.chatMappings.delete(waJid);
                await this.telegramBot.sendMessage(chatId, `✅ Unlinked thread from ${waJid}`, { message_thread_id: topicId });
            } else {
                await this.telegramBot.sendMessage(chatId, '⚠️ This thread is not linked to any WhatsApp chat.', { message_thread_id: topicId });
            }
        } catch (error) {
            logger.error('Error in unlinkthread command:', error);
            this.stats.errors++;
        }
    }

    async handleGetProfilePictureCommand({ msg, args, chatId }) {
        try {
            const jid = args[0];
            if (!jid) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Please provide a user or group JID.');
                return;
            }

            const ppUrl = await this.bot.sock.profilePictureUrl(jid, 'image');
            if (ppUrl) {
                await this.telegramBot.sendPhoto(chatId, ppUrl, { caption: `Profile picture for ${jid}` });
                this.profilePicCache.set(jid, ppUrl);
            } else {
                await this.telegramBot.sendMessage(chatId, `No profile picture found for ${jid}`);
            }
        } catch (error) {
            logger.error('Error in getprofilepicture command:', error);
            this.stats.errors++;
        }
    }

    async handleSyncTopicNamesCommand({ msg, chatId }) {
        try {
            const groups = await this.bot.sock.groupFetchAllParticipating();
            for (const [jid, topicId] of this.chatMappings.entries()) {
                const name = groups[jid]?.subject || await this.getChatName(jid);
                await this.telegramBot.editForumTopic(this.config.chatId, topicId, { name });
            }
            await this.telegramBot.sendMessage(chatId, '✅ Updated all topic names.');
        } catch (error) {
            logger.error('Error in synctopicnames command:', error);
            this.stats.errors++;
        }
    }

    async handleSendCommand({ msg, args, chatId, topicId }) {
        try {
            const targetJid = args[0];
            if (!targetJid) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Please provide a target JID.', { message_thread_id: topicId });
                return;
            }

            if (!msg.reply_to_message) {
                await this.telegramBot.sendMessage(chatId, '⚠️ Please reply to a message to send.', { message_thread_id: topicId });
                return;
            }

            await this.forwardTelegramToWhatsApp(msg.reply_to_message, targetJid);
        } catch (error) {
            logger.error('Error in send command:', error);
            this.stats.errors++;
        }
    }

    async getChatName(jid) {
        try {
            const chat = await this.bot.sock.fetchChat(jid);
            return chat?.name || chat?.subject || jid.split('@')[0];
        } catch (error) {
            logger.error(`Error fetching chat name for ${jid}:`, error);
            return jid.split('@')[0];
        }
    }

    async getSenderName(jid) {
        const contact = this.userMappings.get(jid);
        return contact?.name || jid.split('@')[0];
    }

    async saveTempFile(buffer, extension) {
        const filePath = path.join(this.tempDir, `${Date.now()}${extension}`);
        await fs.writeFile(filePath, Buffer.concat(await buffer.toArray()));
        return filePath;
    }

    getUptime() {
        const diff = Date.now() - this.startTime.getTime();
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        return `${hours}h ${minutes}m`;
    }

    async syncWhatsAppConnection() {
        try {
            if (this.telegramBot && this.config.logChannel) {
                await this.telegramBot.sendMessage(this.config.logChannel, '🔄 WhatsApp connection synced.');
            }
        } catch (error) {
            logger.error('Error syncing WhatsApp connection:', error);
            this.stats.errors++;
        }
    }

    async shutdown() {
        try {
            if (this.telegramBot) {
                await this.telegramBot.stopPolling();
                this.telegramBot = null;
            }
            await fs.remove(this.tempDir);
            logger.info('✅ Telegram Bridge shutdown complete');
        } catch (error) {
            logger.error('Error during Telegram Bridge shutdown:', error);
            this.stats.errors++;
        }
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot || !this.config.logChannel) return;
        
        try {
            await this.telegramBot.sendMessage(this.config.logChannel, `**${title}**\n${message}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error logging to Telegram:', error);
            this.stats.errors++;
        }
    }

    async handleCallbackQuery(query) {
        try {
            await this.telegramBot.answerCallbackQuery(query.id);
            // Add callback query handling if needed
        } catch (error) {
            logger.error('Error handling callback query:', error);
            this.stats.errors++;
        }
    }
}

module.exports = TelegramBridge;
