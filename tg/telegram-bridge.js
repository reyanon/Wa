const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const logger = require('../core/logger');
const config = require('../config');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

class TelegramBridge {
    constructor(bot) {
        this.bot = bot;
        this.name = 'telegram-bridge';
        this.version = '1.12.1';
        this.description = 'Complete Telegram Bridge for WhatsApp Bot - All Features Ported';
        
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
        this.typingIndicators = new Map(); // Chat -> typing timeout
        this.lastMessageTime = new Map(); // Chat -> last message timestamp
        this.messageQueue = new Map(); // Chat -> message queue for rate limiting
        this.processingQueue = false;
        
        // Configuration
        this.config = {
            botToken: config.get('telegram.botToken'),
            chatId: config.get('telegram.chatId'),
            logChannel: config.get('telegram.logChannel'),
            enabled: config.get('telegram.enabled'),
            ownerIds: config.get('telegram.ownerIds', []),
            sudoUsers: config.get('telegram.sudoUsers', []),
            skipVideoStickers: config.get('telegram.skipVideoStickers', false),
            sendPresence: config.get('telegram.sendPresence', true),
            sendReadReceipts: config.get('telegram.sendReadReceipts', true),
            silentConfirmation: config.get('telegram.silentConfirmation', false),
            confirmationType: config.get('telegram.confirmationType', 'emoji'), // emoji, text, none
            spoilerViewOnce: config.get('telegram.spoilerViewOnce', true),
            reactions: config.get('telegram.reactions', true),
            skipStartupMessage: config.get('telegram.skipStartupMessage', false),
            autoCreateTopics: config.get('telegram.autoCreateTopics', true),
            sendUserInfo: config.get('telegram.sendUserInfo', true),
            sendProfilePictures: config.get('telegram.sendProfilePictures', true),
            handleGroupEvents: config.get('telegram.handleGroupEvents', true),
            handleCallLogs: config.get('telegram.handleCallLogs', true),
            handleStatusUpdates: config.get('telegram.handleStatusUpdates', true),
            handlePresenceUpdates: config.get('telegram.handlePresenceUpdates', true),
            handleMessageRevocations: config.get('telegram.handleMessageRevocations', true),
            handleReactions: config.get('telegram.handleReactions', true),
            maxFileSize: config.get('telegram.maxFileSize', 50 * 1024 * 1024), // 50MB
            messageQueueDelay: config.get('telegram.messageQueueDelay', 1000), // 1 second
            typingTimeout: config.get('telegram.typingTimeout', 3000), // 3 seconds
            revokeTimeout: config.get('telegram.revokeTimeout', 300000), // 5 minutes
            mediaQuality: config.get('telegram.mediaQuality', 'high'), // high, medium, low
            compressImages: config.get('telegram.compressImages', false),
            compressVideos: config.get('telegram.compressVideos', false),
            convertStickers: config.get('telegram.convertStickers', true),
            forwardAsQuote: config.get('telegram.forwardAsQuote', false),
            showMessageIds: config.get('telegram.showMessageIds', false),
            showTimestamps: config.get('telegram.showTimestamps', true),
            showSenderInfo: config.get('telegram.showSenderInfo', true),
            groupMessageFormat: config.get('telegram.groupMessageFormat', 'detailed'), // detailed, simple, minimal
            privateMessageFormat: config.get('telegram.privateMessageFormat', 'simple'),
            statusMessageFormat: config.get('telegram.statusMessageFormat', 'detailed'),
            callLogFormat: config.get('telegram.callLogFormat', 'detailed'),
            errorReporting: config.get('telegram.errorReporting', true),
            debugMode: config.get('telegram.debugMode', false),
            rateLimitMessages: config.get('telegram.rateLimitMessages', true),
            rateLimitCommands: config.get('telegram.rateLimitCommands', true),
            maxMessagesPerMinute: config.get('telegram.maxMessagesPerMinute', 30),
            maxCommandsPerMinute: config.get('telegram.maxCommandsPerMinute', 10)
        };

        // Commands - Complete set from Go version
        this.commands = [
            {
                name: 'tgstart',
                description: 'Show Telegram bridge status and uptime',
                usage: 'tgstart',
                execute: this.handleStartCommand.bind(this)
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
                name: 'tglink',
                description: 'Link current topic to WhatsApp chat',
                usage: 'tglink <jid>',
                execute: this.handleLinkTopicCommand.bind(this)
            },
            {
                name: 'tgunlink',
                description: 'Unlink current topic from WhatsApp chat',
                usage: 'tgunlink',
                execute: this.handleUnlinkTopicCommand.bind(this)
            },
            {
                name: 'tgprofile',
                description: 'Get profile picture of user or group',
                usage: 'tgprofile <jid>',
                execute: this.handleGetProfilePictureCommand.bind(this)
            },
            {
                name: 'tginfo',
                description: 'Get detailed info about user or group',
                usage: 'tginfo <jid>',
                execute: this.handleGetInfoCommand.bind(this)
            },
            {
                name: 'tgstatus',
                description: 'Get WhatsApp status of user',
                usage: 'tgstatus <jid>',
                execute: this.handleGetStatusCommand.bind(this)
            },
            {
                name: 'tgblock',
                description: 'Block a user in WhatsApp',
                usage: 'tgblock <jid>',
                execute: this.handleBlockCommand.bind(this)
            },
            {
                name: 'tgunblock',
                description: 'Unblock a user in WhatsApp',
                usage: 'tgunblock <jid>',
                execute: this.handleUnblockCommand.bind(this)
            },
            {
                name: 'tgmute',
                description: 'Mute a chat in WhatsApp',
                usage: 'tgmute <jid> [duration]',
                execute: this.handleMuteCommand.bind(this)
            },
            {
                name: 'tgunmute',
                description: 'Unmute a chat in WhatsApp',
                usage: 'tgunmute <jid>',
                execute: this.handleUnmuteCommand.bind(this)
            },
            {
                name: 'tgarchive',
                description: 'Archive a chat in WhatsApp',
                usage: 'tgarchive <jid>',
                execute: this.handleArchiveCommand.bind(this)
            },
            {
                name: 'tgunarchive',
                description: 'Unarchive a chat in WhatsApp',
                usage: 'tgunarchive <jid>',
                execute: this.handleUnarchiveCommand.bind(this)
            },
            {
                name: 'tgpin',
                description: 'Pin a chat in WhatsApp',
                usage: 'tgpin <jid>',
                execute: this.handlePinCommand.bind(this)
            },
            {
                name: 'tgunpin',
                description: 'Unpin a chat in WhatsApp',
                usage: 'tgunpin <jid>',
                execute: this.handleUnpinCommand.bind(this)
            },
            {
                name: 'tgread',
                description: 'Mark messages as read in WhatsApp',
                usage: 'tgread <jid>',
                execute: this.handleMarkReadCommand.bind(this)
            },
            {
                name: 'tgunread',
                description: 'Mark messages as unread in WhatsApp',
                usage: 'tgunread <jid>',
                execute: this.handleMarkUnreadCommand.bind(this)
            },
            {
                name: 'tgpresence',
                description: 'Set presence status in WhatsApp',
                usage: 'tgpresence <available|unavailable|composing|recording>',
                execute: this.handleSetPresenceCommand.bind(this)
            },
            {
                name: 'tgstats',
                description: 'Show bridge statistics',
                usage: 'tgstats',
                execute: this.handleStatsCommand.bind(this)
            },
            {
                name: 'tgconfig',
                description: 'Show or update bridge configuration',
                usage: 'tgconfig [key] [value]',
                execute: this.handleConfigCommand.bind(this)
            },
            {
                name: 'tgtest',
                description: 'Test bridge functionality',
                usage: 'tgtest',
                execute: this.handleTestCommand.bind(this)
            },
            {
                name: 'tghelp',
                description: 'Get all available Telegram bridge commands',
                usage: 'tghelp [command]',
                execute: this.handleHelpCommand.bind(this)
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
            'message_reaction': this.onMessageReaction.bind(this)
        };

        this.startTime = new Date();
        this.stats = {
            messagesForwarded: 0,
            mediaForwarded: 0,
            commandsExecuted: 0,
            errorsEncountered: 0,
            topicsCreated: 0,
            callsLogged: 0,
            statusUpdates: 0,
            reactionsHandled: 0,
            presenceUpdates: 0,
            groupEvents: 0
        };
    }

    async init() {
        logger.info('🔧 Initializing Complete Telegram Bridge module...');
        
        await fs.ensureDir(this.tempDir);
        
        if (this.config.enabled && this.isProperlyConfigured()) {
            await this.initializeTelegramBot();
            this.startMessageQueue();
        } else {
            logger.warn('⚠️ Telegram bridge not started - check configuration');
        }
        
        logger.info('✅ Complete Telegram Bridge module initialized');
    }

    async initializeTelegramBot() {
        if (!this.isProperlyConfigured()) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly');
            return false;
        }

        try {
            this.telegramBot = new TelegramBot(this.config.botToken, { 
                polling: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    }
                }
            });
            
            await this.setupTelegramHandlers();
            await this.registerBotCommands();
            
            if (!this.config.skipStartupMessage) {
                await this.sendStartupMessage();
            }
            
            logger.info('✅ Telegram bridge started successfully');
            return true;
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
            return false;
        }
    }

    async setupTelegramHandlers() {
        // Handle all message types
        this.telegramBot.on('message', async (msg) => {
            if (this.shouldProcessTelegramMessage(msg)) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle callback queries (for revoke buttons, etc.)
        this.telegramBot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });

        // Handle inline queries
        this.telegramBot.on('inline_query', async (query) => {
            await this.handleInlineQuery(query);
        });

        // Handle chosen inline results
        this.telegramBot.on('chosen_inline_result', async (result) => {
            await this.handleChosenInlineResult(result);
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
            this.stats.errorsEncountered++;
        });

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
            this.stats.errorsEncountered++;
        });

        logger.info('📱 Telegram message handlers set up');
    }

    async registerBotCommands() {
        try {
            const botCommands = this.commands
                .filter(cmd => cmd.description && !cmd.name.includes('config'))
                .map(cmd => ({
                    command: cmd.name,
                    description: cmd.description
                }));

            await this.telegramBot.setMyCommands(botCommands);
            logger.info(`📋 Registered ${botCommands.length} bot commands`);
        } catch (error) {
            logger.error('❌ Failed to register bot commands:', error);
        }
    }

    shouldProcessTelegramMessage(msg) {
        // Only process messages in the configured supergroup with topics
        return msg.chat.type === 'supergroup' && 
               msg.chat.id.toString() === this.config.chatId.toString() &&
               msg.is_topic_message;
    }

    async handleTelegramMessage(msg) {
        try {
            // Handle commands first
            if (msg.text && msg.text.startsWith('/')) {
                const command = msg.text.split(' ')[0].substring(1);
                const params = msg.text.split(' ').slice(1);
                
                const cmdHandler = this.commands.find(c => c.name === command);
                if (cmdHandler) {
                    if (this.config.rateLimitCommands && !this.checkCommandRateLimit(msg.from.id)) {
                        return this.sendRateLimitMessage(msg);
                    }
                    this.stats.commandsExecuted++;
                    return await cmdHandler.execute(msg, params, { bot: this.bot });
                }
            }

            // Handle regular messages - forward to WhatsApp
            const whatsappJid = this.findWhatsAppJidByTopic(msg.message_thread_id);
            if (!whatsappJid) {
                return; // No mapping found
            }

            if (this.config.rateLimitMessages && !this.checkMessageRateLimit(whatsappJid)) {
                return this.sendRateLimitMessage(msg);
            }

            await this.forwardTelegramMessageToWhatsApp(msg, whatsappJid);
            
        } catch (error) {
            logger.error('❌ Error handling Telegram message:', error);
            this.stats.errorsEncountered++;
            if (this.config.errorReporting) {
                await this.sendErrorToTelegram(msg, 'Message handling failed', error);
            }
        }
    }

    async forwardTelegramMessageToWhatsApp(msg, whatsappJid) {
        try {
            let waMessage = {};
            let sentMsg = null;

            // Handle reply to message
            let quotedMsg = null;
            if (msg.reply_to_message) {
                quotedMsg = await this.getQuotedMessage(msg.reply_to_message);
            }

            if (msg.text) {
                // Text message
                waMessage = { text: msg.text };
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                
            } else if (msg.photo) {
                // Photo
                const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
                const fileUrl = await this.telegramBot.getFileLink(photo.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                let processedBuffer = buffer;
                if (this.config.compressImages) {
                    processedBuffer = await this.compressImage(buffer);
                }
                
                waMessage = {
                    image: processedBuffer,
                    caption: msg.caption || '',
                    viewOnce: msg.has_media_spoiler && this.config.spoilerViewOnce
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.video) {
                // Video
                const fileUrl = await this.telegramBot.getFileLink(msg.video.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                let processedBuffer = buffer;
                if (this.config.compressVideos) {
                    processedBuffer = await this.compressVideo(buffer);
                }
                
                waMessage = {
                    video: processedBuffer,
                    caption: msg.caption || '',
                    viewOnce: msg.has_media_spoiler && this.config.spoilerViewOnce,
                    gifPlayback: msg.video.mime_type === 'video/mp4' && msg.video.duration < 60
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.animation) {
                // GIF/Animation
                const fileUrl = await this.telegramBot.getFileLink(msg.animation.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                waMessage = {
                    video: buffer,
                    caption: msg.caption || '',
                    gifPlayback: true,
                    viewOnce: msg.has_media_spoiler && this.config.spoilerViewOnce
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.audio) {
                // Audio
                const fileUrl = await this.telegramBot.getFileLink(msg.audio.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                waMessage = {
                    audio: buffer,
                    mimetype: msg.audio.mime_type || 'audio/mp4',
                    seconds: msg.audio.duration
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.voice) {
                // Voice note
                const fileUrl = await this.telegramBot.getFileLink(msg.voice.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                waMessage = {
                    audio: buffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true,
                    seconds: msg.voice.duration
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.video_note) {
                // Video note (circle video)
                const fileUrl = await this.telegramBot.getFileLink(msg.video_note.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                waMessage = {
                    video: buffer,
                    mimetype: 'video/mp4',
                    ptv: true,
                    seconds: msg.video_note.duration
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.document) {
                // Document
                const fileUrl = await this.telegramBot.getFileLink(msg.document.file_id);
                const buffer = await this.downloadFile(fileUrl);
                
                waMessage = {
                    document: buffer,
                    fileName: msg.document.file_name || 'document',
                    mimetype: msg.document.mime_type || 'application/octet-stream',
                    caption: msg.caption || ''
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.sticker) {
                // Sticker
                if (this.config.convertStickers) {
                    const fileUrl = await this.telegramBot.getFileLink(msg.sticker.file_id);
                    const buffer = await this.downloadFile(fileUrl);
                    
                    let stickerBuffer = buffer;
                    if (msg.sticker.is_animated) {
                        // Convert TGS to WebP
                        stickerBuffer = await this.convertTgsToWebp(buffer);
                    } else if (msg.sticker.is_video) {
                        // Convert WebM to WebP
                        stickerBuffer = await this.convertWebmToWebp(buffer);
                    }
                    
                    waMessage = {
                        sticker: stickerBuffer
                    };
                    
                    if (quotedMsg) {
                        waMessage.contextInfo = {
                            stanzaId: quotedMsg.stanzaId,
                            participant: quotedMsg.participant,
                            quotedMessage: quotedMsg.message
                        };
                    }
                    
                    sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                } else {
                    // Send as image
                    const fileUrl = await this.telegramBot.getFileLink(msg.sticker.file_id);
                    const buffer = await this.downloadFile(fileUrl);
                    
                    waMessage = {
                        image: buffer,
                        caption: '🎭 Sticker from Telegram'
                    };
                    
                    if (quotedMsg) {
                        waMessage.contextInfo = {
                            stanzaId: quotedMsg.stanzaId,
                            participant: quotedMsg.participant,
                            quotedMessage: quotedMsg.message
                        };
                    }
                    
                    sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                }
                this.stats.mediaForwarded++;
                
            } else if (msg.location) {
                // Location
                waMessage = {
                    location: {
                        degreesLatitude: msg.location.latitude,
                        degreesLongitude: msg.location.longitude
                    }
                };
                
                if (msg.location.live_period) {
                    waMessage.location.isLive = true;
                    waMessage.location.accuracyInMeters = msg.location.horizontal_accuracy || 0;
                }
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.venue) {
                // Venue
                waMessage = {
                    location: {
                        degreesLatitude: msg.venue.location.latitude,
                        degreesLongitude: msg.venue.location.longitude,
                        name: msg.venue.title,
                        address: msg.venue.address
                    }
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.contact) {
                // Contact
                const vcard = this.createVCard(msg.contact);
                waMessage = {
                    contacts: {
                        displayName: `${msg.contact.first_name} ${msg.contact.last_name || ''}`.trim(),
                        contacts: [{
                            vcard: vcard
                        }]
                    }
                };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
                this.stats.mediaForwarded++;
                
            } else if (msg.poll) {
                // Poll - convert to text
                let pollText = `📊 *Poll from Telegram*\n\n`;
                pollText += `*Question:* ${msg.poll.question}\n\n`;
                pollText += `*Options:*\n`;
                msg.poll.options.forEach((option, index) => {
                    pollText += `${index + 1}. ${option.text} (${option.voter_count} votes)\n`;
                });
                
                waMessage = { text: pollText };
                
                if (quotedMsg) {
                    waMessage.contextInfo = {
                        stanzaId: quotedMsg.stanzaId,
                        participant: quotedMsg.participant,
                        quotedMessage: quotedMsg.message
                    };
                }
                
                sentMsg = await this.bot.sock.sendMessage(whatsappJid, waMessage);
            }

            // Send confirmation and store message pair
            if (sentMsg) {
                await this.sendConfirmation(msg);
                
                // Store message pair
                this.messagePairs.set(msg.message_id, {
                    whatsappId: sentMsg.key.id,
                    whatsappJid: whatsappJid,
                    telegramMessageId: msg.message_id,
                    timestamp: new Date()
                });
                
                this.stats.messagesForwarded++;
                
                // Auto-cleanup old message pairs
                this.cleanupOldMessagePairs();
            }
            
        } catch (error) {
            logger.error('❌ Error forwarding to WhatsApp:', error);
            this.stats.errorsEncountered++;
            await this.sendErrorToTelegram(msg, 'Failed to send to WhatsApp', error);
        }
    }

    async sendConfirmation(msg) {
        if (this.config.confirmationType === 'emoji') {
            // React with thumbs up
            try {
                await this.telegramBot.setMessageReaction(
                    msg.chat.id,
                    msg.message_id,
                    [{ type: 'emoji', emoji: '👍' }]
                );
            } catch (error) {
                logger.debug('Could not react to message:', error);
            }
        } else if (this.config.confirmationType === 'text') {
            // Send confirmation message
            const confirmMsg = await this.telegramBot.sendMessage(
                msg.chat.id,
                '✅ Message sent to WhatsApp',
                {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id,
                    disable_notification: this.config.silentConfirmation
                }
            );
            
            // Auto-delete after 5 seconds
            setTimeout(async () => {
                try {
                    await this.telegramBot.deleteMessage(msg.chat.id, confirmMsg.message_id);
                } catch (error) {
                    logger.debug('Could not delete confirmation message:', error);
                }
            }, 5000);
        }
    }

    async downloadFile(url) {
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            maxContentLength: this.config.maxFileSize,
            timeout: 30000
        });
        return Buffer.from(response.data);
    }

    // Command Handlers - Complete implementation
    async handleStartCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        const uptime = this.getUptime();
        const mappings = this.chatMappings.size;
        const users = this.userMappings.size;

        const statusText = 
            `🤖 *Telegram Bridge Status*\n\n` +
            `• *Up Since*: ${this.startTime.toLocaleString()} [ ${uptime} ]\n` +
            `• *Version*: \`${this.version}\`\n` +
            `• *Chat Mappings*: ${mappings}\n` +
            `• *User Mappings*: ${users}\n` +
            `• *Messages Forwarded*: ${this.stats.messagesForwarded}\n` +
            `• *Media Forwarded*: ${this.stats.mediaForwarded}\n` +
            `• *Commands Executed*: ${this.stats.commandsExecuted}\n` +
            `• *Topics Created*: ${this.stats.topicsCreated}\n` +
            `• *Configuration*: ${this.isProperlyConfigured() ? '✅ Valid' : '❌ Invalid'}\n` +
            `• *WhatsApp Status*: ${this.bot.sock?.user ? '✅ Connected' : '❌ Disconnected'}`;

        await this.telegramBot.sendMessage(msg.chat.id, statusText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async handleGetGroupsCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        try {
            const groups = await this.bot.sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);

            if (groupList.length === 0) {
                return this.telegramBot.sendMessage(msg.chat.id, '📭 No groups found', {
                    message_thread_id: msg.message_thread_id
                });
            }

            let outputText = `📋 *WhatsApp Groups (${groupList.length})*\n\n`;
            
            for (let i = 0; i < groupList.length; i++) {
                const group = groupList[i];
                const participantCount = group.participants ? group.participants.length : 0;
                const groupInfo = `${i + 1}. *${this.escapeMarkdown(group.subject)}*\n` +
                                 `   👥 ${participantCount} members\n` +
                                 `   🆔 \`${group.id}\`\n` +
                                 `   📅 Created: ${new Date(group.creation * 1000).toLocaleDateString()}\n\n`;
                
                if ((outputText + groupInfo).length > 4000) {
                    await this.telegramBot.sendMessage(msg.chat.id, outputText, {
                        message_thread_id: msg.message_thread_id,
                        parse_mode: 'Markdown'
                    });
                    outputText = groupInfo;
                    await this.sleep(500);
                } else {
                    outputText += groupInfo;
                }
            }

            if (outputText.length > 0) {
                await this.telegramBot.sendMessage(msg.chat.id, outputText, {
                    message_thread_id: msg.message_thread_id,
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            logger.error('❌ Failed to get groups:', error);
            await this.sendErrorMessage(msg, 'Failed to retrieve groups', error);
        }
    }

    async handleFindContactCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0]) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                `❓ *Usage:* \`/tgfind <search_string>\`\n*Example:* \`/tgfind john\``, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        const query = params.join(' ').toLowerCase();
        const results = this.fuzzyFindContacts(query);

        if (results.length === 0) {
            return this.telegramBot.sendMessage(msg.chat.id, '❌ No matching contacts found', {
                message_thread_id: msg.message_thread_id
            });
        }

        let outputText = `🔍 *Search Results for "${this.escapeMarkdown(query)}" (${results.length})*\n\n`;
        
        for (const result of results.slice(0, 20)) { // Limit to 20 results
            outputText += `• *${this.escapeMarkdown(result.name)}*\n  \`${result.jid}\`\n`;
            if (result.status) {
                outputText += `  📝 ${this.escapeMarkdown(result.status)}\n`;
            }
            outputText += '\n';
        }

        if (results.length > 20) {
            outputText += `... and ${results.length - 20} more results`;
        }

        await this.telegramBot.sendMessage(msg.chat.id, outputText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async handleHelpCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (params[0]) {
            // Show help for specific command
            const command = this.commands.find(c => c.name === params[0]);
            if (command) {
                const helpText = 
                    `📋 *Command Help: ${command.name}*\n\n` +
                    `*Description:* ${command.description}\n` +
                    `*Usage:* \`/${command.usage}\``;
                
                await this.telegramBot.sendMessage(msg.chat.id, helpText, {
                    message_thread_id: msg.message_thread_id,
                    parse_mode: 'Markdown'
                });
            } else {
                await this.telegramBot.sendMessage(msg.chat.id, 
                    `❌ Command '${params[0]}' not found`, {
                    message_thread_id: msg.message_thread_id
                });
            }
        } else {
            // Show all commands
            let helpText = '📋 *Available Telegram Bridge Commands*\n\n';
            
            const categories = {
                'Basic': ['tgstart', 'tghelp', 'tgstats', 'tgtest'],
                'WhatsApp Management': ['tggroups', 'tgfind', 'tgjoin', 'tgrestart'],
                'Chat Control': ['tglink', 'tgunlink', 'tgread', 'tgunread', 'tgmute', 'tgunmute'],
                'User Management': ['tgprofile', 'tginfo', 'tgstatus', 'tgblock', 'tgunblock'],
                'Message Control': ['tgrevoke', 'tgclear', 'tgpresence'],
                'Configuration': ['tgconfig', 'tgsync']
            };

            for (const [category, commandNames] of Object.entries(categories)) {
                helpText += `*${category}:*\n`;
                for (const cmdName of commandNames) {
                    const cmd = this.commands.find(c => c.name === cmdName);
                    if (cmd) {
                        helpText += `• \`/${cmd.name}\` - ${cmd.description}\n`;
                    }
                }
                helpText += '\n';
            }

            helpText += `Use \`/tghelp <command>\` for detailed help on a specific command.`;

            await this.telegramBot.sendMessage(msg.chat.id, helpText, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }
    }

    // Message hook handlers
    async onWhatsAppConnected(data) {
        logger.info('📱 WhatsApp connected - initializing Telegram sync');
        if (this.telegramBot) {
            await this.syncWhatsAppConnection();
        }
    }

    async syncWhatsAppConnection() {
        // Send connection notification to Telegram
        try {
            await this.telegramBot.sendMessage(
                this.config.chatId,
                '✅ WhatsApp connected and ready for bridging!'
            );
        } catch (error) {
            logger.error('Failed to send connection notification:', error);
        }
    }

    async onMessageReceived(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { msg } = data;
        logger.debug(`📩 Processing WhatsApp message from ${msg.key.remoteJid}`);
        await this.syncWhatsAppMessage(msg);
    }

    async syncWhatsAppMessage(whatsappMsg) {
        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            // Skip own messages unless configured otherwise
            if (whatsappMsg.key.fromMe && !this.config.sendMyMessages) {
                return;
            }
            
            // Update user mapping
            await this.updateUserMapping(participant, whatsappMsg);
            
            // Get or create topic
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            if (!topicId) return;

            // Handle different message types
            const message = whatsappMsg.message;
            let sentMessageId = null;
            
            if (message?.imageMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
            } else if (message?.videoMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
            } else if (message?.audioMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
            } else if (message?.documentMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
            } else if (message?.stickerMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
            } else if (message?.locationMessage) {
                sentMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
            } else if (message?.liveLocationMessage) {
                sentMessageId = await this.handleWhatsAppLiveLocation(whatsappMsg, topicId);
            } else if (message?.contactMessage || message?.contactsArrayMessage) {
                sentMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
            } else if (message?.pollCreationMessage) {
                sentMessageId = await this.handleWhatsAppPoll(whatsappMsg, topicId);
            } else if (message?.pollUpdateMessage) {
                sentMessageId = await this.handleWhatsAppPollUpdate(whatsappMsg, topicId);
            } else {
                const text = this.extractText(whatsappMsg);
                if (text) {
                    sentMessageId = await this.sendSimpleMessage(topicId, text, sender, participant, whatsappMsg);
                }
            }

            // Store message pair for revoke functionality
            if (sentMessageId && whatsappMsg.key.id) {
                this.messagePairs.set(sentMessageId, {
                    whatsappId: whatsappMsg.key.id,
                    whatsappJid: sender,
                    telegramMessageId: sentMessageId,
                    timestamp: new Date()
                });
            }

            this.stats.messagesForwarded++;

        } catch (error) {
            logger.error('❌ Error syncing WhatsApp message:', error);
            this.stats.errorsEncountered++;
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            const message = whatsappMsg.message;
            let mediaMessage = null;
            let caption = '';

            // Get the media message based on type
            switch (mediaType) {
                case 'image':
                    mediaMessage = message.imageMessage;
                    caption = mediaMessage?.caption || '';
                    break;
                case 'video':
                    mediaMessage = message.videoMessage;
                    caption = mediaMessage?.caption || '';
                    break;
                case 'audio':
                    mediaMessage = message.audioMessage;
                    break;
                case 'document':
                    mediaMessage = message.documentMessage;
                    caption = mediaMessage?.caption || '';
                    break;
                case 'sticker':
                    mediaMessage = message.stickerMessage;
                    break;
            }

            if (!mediaMessage) return null;

            // Download media from WhatsApp
            const buffer = await downloadContentFromMessage(mediaMessage, mediaType);
            const chunks = [];
            for await (const chunk of buffer) {
                chunks.push(chunk);
            }
            const mediaBuffer = Buffer.concat(chunks);

            // Send to Telegram based on type
            let sentMsg = null;
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = await this.getUserName(participant);
            const timestamp = this.config.showTimestamps ? 
                `\n🕐 ${new Date(whatsappMsg.messageTimestamp * 1000).toLocaleString()}` : '';
            
            let fullCaption = '';
            if (this.config.showSenderInfo) {
                fullCaption = `👤 ${senderName}${timestamp}`;
                if (caption) {
                    fullCaption += `\n\n${caption}`;
                }
            } else {
                fullCaption = caption;
            }

            const messageOptions = {
                message_thread_id: topicId,
                caption: fullCaption.trim() || undefined
            };

            switch (mediaType) {
                case 'image':
                    if (mediaMessage.viewOnce) {
                        messageOptions.has_spoiler = true;
                    }
                    sentMsg = await this.telegramBot.sendPhoto(
                        this.config.chatId,
                        mediaBuffer,
                        messageOptions
                    );
                    break;
                case 'video':
                    if (mediaMessage.viewOnce) {
                        messageOptions.has_spoiler = true;
                    }
                    if (mediaMessage.gifPlayback) {
                        sentMsg = await this.telegramBot.sendAnimation(
                            this.config.chatId,
                            mediaBuffer,
                            messageOptions
                        );
                    } else {
                        sentMsg = await this.telegramBot.sendVideo(
                            this.config.chatId,
                            mediaBuffer,
                            messageOptions
                        );
                    }
                    break;
                case 'audio':
                    if (mediaMessage.ptt) {
                        // Voice message
                        sentMsg = await this.telegramBot.sendVoice(
                            this.config.chatId,
                            mediaBuffer,
                            {
                                message_thread_id: topicId,
                                caption: `🎤 ${senderName}${timestamp}`
                            }
                        );
                    } else {
                        // Audio file
                        sentMsg = await this.telegramBot.sendAudio(
                            this.config.chatId,
                            mediaBuffer,
                            {
                                message_thread_id: topicId,
                                caption: `🎵 ${senderName}${timestamp}`,
                                title: mediaMessage.title || 'Audio',
                                performer: mediaMessage.performer || senderName
                            }
                        );
                    }
                    break;
                case 'document':
                    sentMsg = await this.telegramBot.sendDocument(
                        this.config.chatId,
                        mediaBuffer,
                        messageOptions,
                        {
                            filename: mediaMessage.fileName || 'document'
                        }
                    );
                    break;
                case 'sticker':
                    // Send sticker as photo with sticker emoji
                    sentMsg = await this.telegramBot.sendPhoto(
                        this.config.chatId,
                        mediaBuffer,
                        {
                            message_thread_id: topicId,
                            caption: `🎭 ${senderName} sent a sticker${timestamp}`
                        }
                    );
                    break;
            }

            this.stats.mediaForwarded++;
            return sentMsg?.message_id || null;

        } catch (error) {
            logger.error(`❌ Error handling WhatsApp ${mediaType}:`, error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const locationMsg = whatsappMsg.message.locationMessage;
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = await this.getUserName(participant);
            const timestamp = this.config.showTimestamps ? 
                `\n🕐 ${new Date(whatsappMsg.messageTimestamp * 1000).toLocaleString()}` : '';

            const sentMsg = await this.telegramBot.sendLocation(
                this.config.chatId,
                locationMsg.degreesLatitude,
                locationMsg.degreesLongitude,
                {
                    message_thread_id: topicId
                }
            );

            // Send additional info as text
            let locationInfo = `📍 ${senderName} shared a location${timestamp}`;
            if (locationMsg.name) {
                locationInfo += `\n🏷️ ${locationMsg.name}`;
            }
            if (locationMsg.address) {
                locationInfo += `\n📮 ${locationMsg.address}`;
            }

            await this.telegramBot.sendMessage(
                this.config.chatId,
                locationInfo,
                {
                    message_thread_id: topicId,
                    reply_to_message_id: sentMsg.message_id
                }
            );

            return sentMsg.message_id;
        } catch (error) {
            logger.error('❌ Error handling WhatsApp location:', error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async handleWhatsAppLiveLocation(whatsappMsg, topicId) {
        try {
            const liveLocationMsg = whatsappMsg.message.liveLocationMessage;
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = await this.getUserName(participant);
            const timestamp = this.config.showTimestamps ? 
                `\n🕐 ${new Date(whatsappMsg.messageTimestamp * 1000).toLocaleString()}` : '';

            const sentMsg = await this.telegramBot.sendLocation(
                this.config.chatId,
                liveLocationMsg.degreesLatitude,
                liveLocationMsg.degreesLongitude,
                {
                    message_thread_id: topicId,
                    live_period: liveLocationMsg.contextInfo?.expiration || 900 // 15 minutes default
                }
            );

            // Send additional info
            let locationInfo = `📍🔴 ${senderName} is sharing live location${timestamp}`;
            if (liveLocationMsg.accuracyInMeters) {
                locationInfo += `\n🎯 Accuracy: ${liveLocationMsg.accuracyInMeters}m`;
            }

            await this.telegramBot.sendMessage(
                this.config.chatId,
                locationInfo,
                {
                    message_thread_id: topicId,
                    reply_to_message_id: sentMsg.message_id
                }
            );

            return sentMsg.message_id;
        } catch (error) {
            logger.error('❌ Error handling WhatsApp live location:', error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId) {
        try {
            const contactMsg = whatsappMsg.message.contactMessage || whatsappMsg.message.contactsArrayMessage;
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = await this.getUserName(participant);
            const timestamp = this.config.showTimestamps ? 
                `\n🕐 ${new Date(whatsappMsg.messageTimestamp * 1000).toLocaleString()}` : '';

            let contactText = `👤 ${senderName} shared contact(s)${timestamp}\n\n`;

            if (whatsappMsg.message.contactMessage) {
                // Single contact
                const contact = contactMsg;
                contactText += `📱 *${contact.displayName}*\n`;
                if (contact.vcard) {
                    const vcardLines = contact.vcard.split('\n');
                    for (const line of vcardLines) {
                        if (line.startsWith('TEL:')) {
                            contactText += `📞 ${line.replace('TEL:', '')}\n`;
                        }
                    }
                }
            } else if (whatsappMsg.message.contactsArrayMessage) {
                // Multiple contacts
                const contacts = contactMsg.contacts || [];
                for (let i = 0; i < contacts.length; i++) {
                    const contact = contacts[i];
                    contactText += `${i + 1}. 📱 *${contact.displayName}*\n`;
                    if (contact.vcard) {
                        const vcardLines = contact.vcard.split('\n');
                        for (const line of vcardLines) {
                            if (line.startsWith('TEL:')) {
                                contactText += `   📞 ${line.replace('TEL:', '')}\n`;
                            }
                        }
                    }
                    contactText += '\n';
                }
            }

            const sentMsg = await this.telegramBot.sendMessage(
                this.config.chatId,
                contactText,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );

            return sentMsg.message_id;
        } catch (error) {
            logger.error('❌ Error handling WhatsApp contact:', error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async handleWhatsAppPoll(whatsappMsg, topicId) {
        try {
            const pollMsg = whatsappMsg.message.pollCreationMessage;
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = await this.getUserName(participant);
            const timestamp = this.config.showTimestamps ? 
                `\n🕐 ${new Date(whatsappMsg.messageTimestamp * 1000).toLocaleString()}` : '';

            let pollText = `📊 ${senderName} created a poll${timestamp}\n\n`;
            pollText += `*Question:* ${pollMsg.name}\n\n`;
            pollText += `*Options:*\n`;
            
            pollMsg.options.forEach((option, index) => {
                pollText += `${index + 1}. ${option.optionName}\n`;
            });

            pollText += `\n*Settings:*\n`;
            pollText += `• Multiple choice: ${pollMsg.selectableOptionsCount > 1 ? 'Yes' : 'No'}\n`;
            if (pollMsg.selectableOptionsCount > 1) {
                pollText += `• Max selections: ${pollMsg.selectableOptionsCount}\n`;
            }

            const sentMsg = await this.telegramBot.sendMessage(
                this.config.chatId,
                pollText,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );

            return sentMsg.message_id;
        } catch (error) {
            logger.error('❌ Error handling WhatsApp poll:', error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async sendSimpleMessage(topicId, text, sender, participant, whatsappMsg) {
        try {
            const senderName = await this.getUserName(participant);
            const timestamp = this.config.showTimestamps ? 
                `\n🕐 ${new Date(whatsappMsg.messageTimestamp * 1000).toLocaleString()}` : '';
            
            let fullText = '';
            if (this.config.showSenderInfo) {
                fullText = `👤 ${senderName}${timestamp}\n\n${text}`;
            } else {
                fullText = text;
            }

            // Handle quoted messages
            let replyToMessageId = null;
            if (whatsappMsg.message?.extendedTextMessage?.contextInfo?.stanzaId) {
                const quotedMsgId = whatsappMsg.message.extendedTextMessage.contextInfo.stanzaId;
                // Find corresponding Telegram message
                for (const [tgMsgId, pair] of this.messagePairs.entries()) {
                    if (pair.whatsappId === quotedMsgId) {
                        replyToMessageId = tgMsgId;
                        break;
                    }
                }
            }

            const sentMsg = await this.telegramBot.sendMessage(
                this.config.chatId,
                fullText,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown',
                    reply_to_message_id: replyToMessageId
                }
            );

            return sentMsg.message_id;
        } catch (error) {
            logger.error('❌ Error sending simple message:', error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        try {
            // Check if topic already exists
            if (this.chatMappings.has(chatJid)) {
                return this.chatMappings.get(chatJid);
            }

            if (!this.config.autoCreateTopics) {
                return null;
            }

            // Create new topic
            let topicName = '';
            let topicIcon = '💬';

            if (chatJid.endsWith('@g.us')) {
                // Group chat
                try {
                    const groupMeta = await this.bot.sock.groupMetadata(chatJid);
                    topicName = groupMeta.subject || 'Unknown Group';
                    topicIcon = '👥';
                } catch (error) {
                    topicName = 'WhatsApp Group';
                }
            } else if (chatJid === 'status@broadcast') {
                topicName = 'Status Updates';
                topicIcon = '📊';
            } else if (chatJid === 'call@broadcast') {
                topicName = 'Call Logs';
                topicIcon = '📞';
            } else {
                // Private chat
                const participant = whatsappMsg.key.participant || chatJid;
                topicName = await this.getUserName(participant);
                topicIcon = '👤';
                
                // Send user info when creating private chat topic
                if (this.config.sendUserInfo) {
                    setTimeout(() => this.sendUserInfo(chatJid, participant), 1000);
                }
            }

            const topic = await this.telegramBot.createForumTopic(
                this.config.chatId,
                `${topicIcon} ${topicName}`
            );

            // Store mapping
            this.chatMappings.set(chatJid, topic.message_thread_id);
            this.stats.topicsCreated++;
            
            logger.info(`📝 Created topic: ${topicName} (ID: ${topic.message_thread_id})`);
            return topic.message_thread_id;

        } catch (error) {
            logger.error('❌ Error creating topic:', error);
            this.stats.errorsEncountered++;
            return null;
        }
    }

    async sendUserInfo(chatJid, userJid) {
        try {
            const topicId = this.chatMappings.get(chatJid);
            if (!topicId) return;

            // Get user info
            const userName = await this.getUserName(userJid);
            let userInfo = `👤 *User Information*\n\n`;
            userInfo += `• *Name*: ${this.escapeMarkdown(userName)}\n`;
            userInfo += `• *JID*: \`${userJid}\`\n`;

            // Get additional user info
            try {
                const userStatus = await this.bot.sock.fetchStatus(userJid);
                if (userStatus?.status) {
                    userInfo += `• *Status*: ${this.escapeMarkdown(userStatus.status)}\n`;
                    if (userStatus.setAt) {
                        userInfo += `• *Status Set*: ${new Date(userStatus.setAt).toLocaleString()}\n`;
                    }
                }
            } catch (error) {
                logger.debug('Could not fetch user status:', error);
            }

            // Try to get and send profile picture
            if (this.config.sendProfilePictures) {
                try {
                    const ppUrl = await this.bot.sock.profilePictureUrl(userJid, 'image');
                    if (ppUrl) {
                        await this.telegramBot.sendPhoto(
                            this.config.chatId,
                            ppUrl,
                            {
                                message_thread_id: topicId,
                                caption: userInfo,
                                parse_mode: 'Markdown'
                            }
                        );
                        return;
                    }
                } catch (error) {
                    logger.debug('No profile picture found for user');
                }
            }

            // Send text info if no profile picture
            await this.telegramBot.sendMessage(
                this.config.chatId,
                userInfo,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );

        } catch (error) {
            logger.error('❌ Error sending user info:', error);
            this.stats.errorsEncountered++;
        }
    }

    async getUserName(jid) {
        try {
            // Check cache first
            if (this.userMappings.has(jid)) {
                return this.userMappings.get(jid).name;
            }

            // Try to get from WhatsApp
            try {
                const contact = await this.bot.sock.onWhatsApp(jid);
                if (contact && contact[0]) {
                    const name = contact[0].notify || jid.split('@')[0];
                    this.userMappings.set(jid, { 
                        name, 
                        jid,
                        lastUpdated: new Date()
                    });
                    return name;
                }
            } catch (error) {
                logger.debug('Could not fetch contact info:', error);
            }

            // Fallback to JID
            const fallbackName = jid.split('@')[0];
            this.userMappings.set(jid, { 
                name: fallbackName, 
                jid,
                lastUpdated: new Date()
            });
            return fallbackName;
        } catch (error) {
            return jid.split('@')[0];
        }
    }

    async updateUserMapping(jid, whatsappMsg) {
        try {
            const pushName = whatsappMsg.pushName;
            const currentMapping = this.userMappings.get(jid);
            
            if (pushName && (!currentMapping || currentMapping.name !== pushName)) {
                this.userMappings.set(jid, { 
                    name: pushName, 
                    jid,
                    lastSeen: new Date(),
                    lastUpdated: new Date()
                });
                
                // Update topic name if it's a private chat
                if (!jid.endsWith('@g.us') && this.chatMappings.has(jid)) {
                    try {
                        const topicId = this.chatMappings.get(jid);
                        await this.telegramBot.editForumTopic(
                            this.config.chatId,
                            topicId,
                            `👤 ${pushName}`
                        );
                    } catch (error) {
                        logger.debug('Could not update topic name:', error);
                    }
                }
            }
        } catch (error) {
            logger.debug('Error updating user mapping:', error);
        }
    }

    async onStatusReceived(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handleStatusUpdates) return;
        
        const { msg } = data;
        logger.debug('📊 Processing WhatsApp status message');
        await this.syncWhatsAppMessage(msg);
        this.stats.statusUpdates++;
    }

    async onCallReceived(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handleCallLogs) return;

        const { call } = data;
        logger.debug(`📞 Processing call: ${call.status} from ${call.from}`);
        await this.handleCallNotification(call);
    }

    async handleCallNotification(call) {
        try {
            // Prevent duplicate notifications
            const callKey = `${call.from}_${call.id}`;
            if (this.activeCallNotifications.has(callKey)) {
                return;
            }
            this.activeCallNotifications.set(callKey, true);

            // Auto-cleanup after 5 minutes
            setTimeout(() => {
                this.activeCallNotifications.delete(callKey);
            }, 5 * 60 * 1000);

            const callerName = await this.getUserName(call.from);
            const callType = call.isVideo ? '📹 Video Call' : '📞 Voice Call';
            const callStatus = this.getCallStatusText(call.status);
            const timestamp = new Date().toLocaleString();

            let callMessage = `${callType}\n\n`;
            callMessage += `👤 *Caller*: ${this.escapeMarkdown(callerName)}\n`;
            callMessage += `📱 *Status*: ${callStatus}\n`;
            callMessage += `🆔 *JID*: \`${call.from}\`\n`;
            callMessage += `🕐 *Time*: ${timestamp}`;

            if (call.status === 'timeout') {
                callMessage += `\n⏱️ *Duration*: Missed call`;
            } else if (call.status === 'reject') {
                callMessage += `\n❌ *Result*: Call rejected`;
            } else if (call.status === 'accept') {
                callMessage += `\n✅ *Result*: Call accepted`;
            }

            // Get or create calls topic
            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast' },
                messageTimestamp: Math.floor(Date.now() / 1000)
            });

            if (topicId) {
                await this.telegramBot.sendMessage(
                    this.config.chatId,
                    callMessage,
                    {
                        message_thread_id: topicId,
                        parse_mode: 'Markdown'
                    }
                );
                this.stats.callsLogged++;
            }

        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
            this.stats.errorsEncountered++;
        }
    }

    getCallStatusText(status) {
        const statusMap = {
            'offer': 'Incoming',
            'ringing': 'Ringing',
            'timeout': 'Missed',
            'reject': 'Rejected',
            'accept': 'Accepted'
        };
        return statusMap[status] || status;
    }

    async onGroupParticipantsUpdate(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handleGroupEvents) return;
        
        const { id, participants, action } = data;
        await this.handleGroupParticipantsUpdate(id, participants, action);
    }

    async handleGroupParticipantsUpdate(groupId, participants, action) {
        try {
            const topicId = this.chatMappings.get(groupId);
            if (!topicId) return;

            const groupMeta = await this.bot.sock.groupMetadata(groupId);
            const participantNames = await Promise.all(
                participants.map(p => this.getUserName(p))
            );

            let updateMessage = `👥 *Group Update*\n\n`;
            updateMessage += `🏷️ *Group*: ${this.escapeMarkdown(groupMeta.subject)}\n`;
            updateMessage += `👤 *Participants*: ${participantNames.map(n => this.escapeMarkdown(n)).join(', ')}\n`;
            updateMessage += `⚡ *Action*: ${this.getActionText(action)}\n`;
            updateMessage += `🕐 *Time*: ${new Date().toLocaleString()}`;

            await this.telegramBot.sendMessage(
                this.config.chatId,
                updateMessage,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );

            this.stats.groupEvents++;

        } catch (error) {
            logger.error('❌ Error handling group participants update:', error);
            this.stats.errorsEncountered++;
        }
    }

    getActionText(action) {
        const actionMap = {
            'add': 'Added to group',
            'remove': 'Removed from group',
            'promote': 'Promoted to admin',
            'demote': 'Demoted from admin'
        };
        return actionMap[action] || action;
    }

    async onGroupUpdate(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handleGroupEvents) return;
        
        const { id, update } = data;
        await this.handleGroupUpdate(id, update);
    }

    async handleGroupUpdate(groupId, update) {
        try {
            const topicId = this.chatMappings.get(groupId);
            if (!topicId) return;

            let updateMessage = `👥 *Group Settings Updated*\n\n`;
            
            if (update.subject) {
                updateMessage += `🏷️ *New Name*: ${this.escapeMarkdown(update.subject)}\n`;
                
                // Update topic name
                try {
                    await this.telegramBot.editForumTopic(
                        this.config.chatId,
                        topicId,
                        `👥 ${update.subject}`
                    );
                } catch (error) {
                    logger.debug('Could not update topic name:', error);
                }
            }

            if (update.desc) {
                updateMessage += `📝 *New Description*: ${this.escapeMarkdown(update.desc)}\n`;
            }

            if (update.announce !== undefined) {
                updateMessage += `📢 *Announce*: ${update.announce ? 'Only admins can send messages' : 'All participants can send messages'}\n`;
            }

            if (update.restrict !== undefined) {
                updateMessage += `🔒 *Restrict*: ${update.restrict ? 'Only admins can edit group info' : 'All participants can edit group info'}\n`;
            }

            updateMessage += `🕐 *Time*: ${new Date().toLocaleString()}`;

            await this.telegramBot.sendMessage(
                this.config.chatId,
                updateMessage,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );

            this.stats.groupEvents++;

        } catch (error) {
            logger.error('❌ Error handling group update:', error);
            this.stats.errorsEncountered++;
        }
    }

    async onPresenceUpdate(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handlePresenceUpdates) return;
        
        const { id, presences } = data;
        await this.handlePresenceUpdate(id, presences);
    }

    async handlePresenceUpdate(chatId, presences) {
        try {
            const topicId = this.chatMappings.get(chatId);
            if (!topicId) return;

            for (const [jid, presence] of Object.entries(presences)) {
                if (presence.lastKnownPresence === 'composing') {
                    const userName = await this.getUserName(jid);
                    
                    // Clear existing typing indicator
                    if (this.typingIndicators.has(chatId)) {
                        clearTimeout(this.typingIndicators.get(chatId));
                    }
                    
                    const typingMsg = await this.telegramBot.sendMessage(
                        this.config.chatId,
                        `✍️ ${this.escapeMarkdown(userName)} is typing...`,
                        {
                            message_thread_id: topicId
                        }
                    );

                    // Auto-delete typing indicator after configured timeout
                    const timeout = setTimeout(async () => {
                        try {
                            await this.telegramBot.deleteMessage(
                                this.config.chatId,
                                typingMsg.message_id
                            );
                            this.typingIndicators.delete(chatId);
                        } catch (error) {
                            logger.debug('Could not delete typing indicator:', error);
                        }
                    }, this.config.typingTimeout);
                    
                    this.typingIndicators.set(chatId, timeout);
                    this.stats.presenceUpdates++;
                }
            }

        } catch (error) {
            logger.error('❌ Error handling presence update:', error);
            this.stats.errorsEncountered++;
        }
    }

    async onMessageRevoked(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handleMessageRevocations) return;
        
        const { msg } = data;
        await this.handleMessageRevoked(msg);
    }

    async handleMessageRevoked(msg) {
        try {
            // Find corresponding Telegram message
            for (const [tgMsgId, pair] of this.messagePairs.entries()) {
                if (pair.whatsappId === msg.key.id && pair.whatsappJid === msg.key.remoteJid) {
                    // Edit Telegram message to show it was deleted
                    try {
                        const senderName = await this.getUserName(msg.key.participant || msg.key.remoteJid);
                        const deletedText = `🗑️ *Message deleted by ${this.escapeMarkdown(senderName)}*\n\n_This message was deleted_`;
                        
                        await this.telegramBot.editMessageText(
                            deletedText,
                            {
                                chat_id: this.config.chatId,
                                message_id: tgMsgId,
                                parse_mode: 'Markdown'
                            }
                        );
                    } catch (error) {
                        logger.debug('Could not edit deleted message:', error);
                    }
                    break;
                }
            }

        } catch (error) {
            logger.error('❌ Error handling message revocation:', error);
            this.stats.errorsEncountered++;
        }
    }

    async onMessageReaction(data) {
        if (!this.telegramBot || !this.config.enabled || !this.config.handleReactions) return;
        
        const { msg } = data;
        await this.handleMessageReaction(msg);
    }

    async handleMessageReaction(reactionMsg) {
        try {
            const reaction = reactionMsg.message?.reactionMessage;
            if (!reaction) return;

            const topicId = this.chatMappings.get(reactionMsg.key.remoteJid);
            if (!topicId) return;

            const reactorName = await this.getUserName(reactionMsg.key.participant || reactionMsg.key.remoteJid);
            const emoji = reaction.text || '👍';
            const timestamp = new Date(reactionMsg.messageTimestamp * 1000).toLocaleString();

            const reactionText = `${emoji} *${this.escapeMarkdown(reactorName)}* reacted to a message\n🕐 ${timestamp}`;

            await this.telegramBot.sendMessage(
                this.config.chatId,
                reactionText,
                {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );

            this.stats.reactionsHandled++;

        } catch (error) {
            logger.error('❌ Error handling message reaction:', error);
            this.stats.errorsEncountered++;
        }
    }

    // Utility methods
    isAuthorized(userId) {
        return this.config.ownerIds.includes(userId) || 
               this.config.sudoUsers.includes(userId);
    }

    isOwner(userId) {
        return this.config.ownerIds.includes(userId);
    }

    isProperlyConfigured() {
        return this.config.botToken && 
               !this.config.botToken.includes('YOUR_TELEGRAM_BOT_TOKEN_HERE') &&
               this.config.chatId && 
               !this.config.chatId.toString().includes('YOUR_TELEGRAM_CHAT_ID_HERE');
    }

    getUptime() {
        const uptime = Date.now() - this.startTime.getTime();
        const seconds = Math.floor(uptime / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    normalizeJid(jid) {
        if (jid.includes('@')) return jid;
        return `${jid}@s.whatsapp.net`;
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               '';
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) return jid;
        }
        return null;
    }

    findMessagePair(telegramMessageId) {
        return this.messagePairs.get(telegramMessageId);
    }

    escapeMarkdown(text) {
        if (!text) return '';
        return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    }

    fuzzyFindContacts(query) {
        const results = [];
        for (const [jid, userData] of this.userMappings.entries()) {
            if (userData.name.toLowerCase().includes(query)) {
                results.push({
                    jid: jid,
                    name: userData.name,
                    status: userData.status || ''
                });
            }
        }
        return results.sort((a, b) => a.name.localeCompare(b.name));
    }

    checkMessageRateLimit(chatId) {
        if (!this.config.rateLimitMessages) return true;
        
        const now = Date.now();
        const lastTime = this.lastMessageTime.get(chatId) || 0;
        
        if (now - lastTime < this.config.messageQueueDelay) {
            return false;
        }
        
        this.lastMessageTime.set(chatId, now);
        return true;
    }

    checkCommandRateLimit(userId) {
        if (!this.config.rateLimitCommands) return true;
        
        // Simple rate limiting implementation
        const now = Date.now();
        const userKey = `cmd_${userId}`;
        const lastTime = this.lastMessageTime.get(userKey) || 0;
        
        if (now - lastTime < 1000) { // 1 second between commands
            return false;
        }
        
        this.lastMessageTime.set(userKey, now);
        return true;
    }

    async sendRateLimitMessage(msg) {
        try {
            await this.telegramBot.sendMessage(
                msg.chat.id,
                '⏱️ Rate limit exceeded. Please wait before sending another message.',
                {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id
                }
            );
        } catch (error) {
            logger.debug('Could not send rate limit message:', error);
        }
    }

    cleanupOldMessagePairs() {
        const now = Date.now();
        const maxAge = this.config.revokeTimeout;
        
        for (const [msgId, pair] of this.messagePairs.entries()) {
            if (now - pair.timestamp.getTime() > maxAge) {
                this.messagePairs.delete(msgId);
            }
        }
    }

    startMessageQueue() {
        if (this.processingQueue) return;
        
        this.processingQueue = true;
        setInterval(() => {
            // Process any queued messages here if needed
            this.cleanupOldMessagePairs();
        }, 60000); // Every minute
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async sendUnauthorizedMessage(msg) {
        await this.telegramBot.sendMessage(msg.chat.id, 
            '❌ You are not authorized to use this bot.', {
            message_thread_id: msg.message_thread_id
        });
    }

    async sendErrorMessage(msg, title, error) {
        const errorText = `❌ *${title}*\n\n\`${error.message || error}\``;
        await this.telegramBot.sendMessage(msg.chat.id, errorText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async sendErrorToTelegram(msg, title, error) {
        try {
            const errorText = `❌ *${title}*\n\n\`${error.message || error}\``;
            await this.telegramBot.sendMessage(msg.chat.id, errorText, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        } catch (err) {
            logger.error('Failed to send error to Telegram:', err);
        }
    }

    async sendStartupMessage() {
        try {
            if (this.config.ownerIds.length > 0) {
                const message = 
                    `🚀 *Telegram Bridge Started*\n\n` +
                    `✅ Bridge is now active and ready!\n` +
                    `📱 WhatsApp ↔️ Telegram sync enabled\n` +
                    `🔧 Version: ${this.version}\n\n` +
                    `*Features Enabled:*\n` +
                    `• Auto-create topics: ${this.config.autoCreateTopics ? '✅' : '❌'}\n` +
                    `• Send user info: ${this.config.sendUserInfo ? '✅' : '❌'}\n` +
                    `• Handle calls: ${this.config.handleCallLogs ? '✅' : '❌'}\n` +
                    `• Handle reactions: ${this.config.handleReactions ? '✅' : '❌'}\n` +
                    `• Handle presence: ${this.config.handlePresenceUpdates ? '✅' : '❌'}\n\n` +
                    `Use /tghelp to see available commands.`;

                // Send to first owner
                await this.telegramBot.sendMessage(
                    this.config.ownerIds[0],
                    message,
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (error) {
            logger.error('Failed to send startup message:', error);
        }
    }

    async shutdown() {
        logger.info('🛑 Shutting down Complete Telegram Bridge module...');
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        // Clear all timeouts
        for (const timeout of this.typingIndicators.values()) {
            clearTimeout(timeout);
        }
        this.typingIndicators.clear();
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
        
        logger.info('✅ Complete Telegram Bridge module shutdown complete.');
    }
}

module.exports = TelegramBridge;
