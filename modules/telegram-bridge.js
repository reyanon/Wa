const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const axios = require('axios'); // For downloading media
const { fromBuffer } = require('file-type'); // For determining file type
const fs = require('fs').promises; // For temporary file operations
const path = require('path'); // For path manipulation

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.messageQueue = [];
        this.isProcessing = false;
        this.mediaDownloadsDir = path.join(__dirname, '../temp_media_downloads'); // Directory for temp media
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            // Ensure media download directory exists
            await fs.mkdir(this.mediaDownloadsDir, { recursive: true });
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle incoming Telegram messages
        this.telegramBot.on('message', async (msg) => {
            // Ignore messages from non-supergroup chats or if not a topic message, unless it's a private chat
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            } else if (msg.chat.type === 'private') {
                // Handle private messages to the bot if needed, e.g., for commands or direct replies
                // For now, we'll log it or ignore
                logger.debug(`Received private Telegram message from ${msg.from.username || msg.from.first_name}: ${msg.text}`);
            }
        });

        // Handle callback queries
        this.telegramBot.on('callback_query', async (query) => {
            await this.handleCallback(query);
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

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        if (!topicId) return;

        // Send to Telegram
        await this.sendToTelegram(topicId, whatsappMsg, text);
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        let userName = 'Unknown User';
        let userPhone = participant.split('@')[0];
        
        try {
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0]) {
                    const jid = contact[0].jid;
                    const contactInfo = await this.whatsappBot.sock.contacts[jid];
                    userName = contactInfo?.notify || contactInfo?.vname || userPhone;
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
            let topicName;
            
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `📱 ${groupMeta.subject}`;
                } catch (error) {
                    topicName = `📱 Group Chat`;
                }
            } else {
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                topicName = `👤 ${userInfo ? userInfo.name : 'Private Chat'}`;
            }

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message and profile picture if available
            await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup);
            if (!isGroup) {
                await this.sendProfilePicture(topic.message_thread_id, chatJid);
            }
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, chatJid, isGroup) {
        const chatId = config.get('telegram.chatId');
        const welcomeMsg = `🔗 *WhatsApp Bridge Connected*\n\n` +
                          `📱 Chat Type: ${isGroup ? 'Group' : 'Private'}\n` +
                          `🆔 WhatsApp ID: \`${chatJid}\`\n` +
                          `⏰ Connected: ${new Date().toLocaleString()}\n\n` +
                          `💬 Messages from this WhatsApp chat will appear here.\n` +
                          `📤 Reply to messages here to send back to WhatsApp.`;

        await this.telegramBot.sendMessage(chatId, welcomeMsg, {
            message_thread_id: topicId,
            parse_mode: 'Markdown'
        });
    }

    async sendProfilePicture(topicId, jid) {
        const chatId = config.get('telegram.chatId');
        try {
            const ppUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            if (ppUrl) {
                await this.telegramBot.sendPhoto(chatId, ppUrl, {
                    message_thread_id: topicId,
                    caption: '🖼️ Profile Picture Update'
                });
            }
        } catch (error) {
            logger.debug(`Could not send profile picture for ${jid}: ${error.message}`);
        }
    }

    async sendToTelegram(topicId, whatsappMsg, text) {
        if (!topicId) return;

        const chatId = config.get('telegram.chatId');
        const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
        const userInfo = this.userMappings.get(participant);
        
        try {
            // Updated inline keyboard with simplified actions
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '👤 Info', callback_data: `info_${participant}` }
                    ]
                ]
            };

            const messageOptions = {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            };

            if (text) {
                // Send only the text
                await this.telegramBot.sendMessage(chatId, text, messageOptions);
            } else if (whatsappMsg.message?.imageMessage) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendPhoto(chatId, buffer, messageOptions);
            } else if (whatsappMsg.message?.videoMessage) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendVideo(chatId, buffer, messageOptions);
            } else if (whatsappMsg.message?.audioMessage) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                // WhatsApp audio messages are often opus, which Telegram can send as voice.
                // Check if it's a voice message (OGG Opus) or a regular audio file.
                const fileType = await fromBuffer(buffer);
                if (whatsappMsg.message.audioMessage.ptt || (fileType && fileType.ext === 'opus')) {
                    await this.telegramBot.sendVoice(chatId, buffer, messageOptions);
                } else {
                    await this.telegramBot.sendAudio(chatId, buffer, messageOptions);
                }
            } else if (whatsappMsg.message?.documentMessage) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendDocument(chatId, buffer, {
                    ...messageOptions,
                    fileName: whatsappMsg.message.documentMessage.fileName || 'document'
                });
            } else if (whatsappMsg.message?.stickerMessage) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendSticker(chatId, buffer, messageOptions);
            } else if (whatsappMsg.message?.videoNoteMessage) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendVideoNote(chatId, buffer, messageOptions);
            } else {
                logger.warn('Received unhandled WhatsApp message type for Telegram sync:', whatsappMsg.message);
            }

            // Update user message count
            if (this.userMappings.has(participant)) {
                this.userMappings.get(participant).messageCount++;
            }

        } catch (error) {
            logger.error('❌ Failed to send message to Telegram:', error);
        }
    }

    async handleTelegramMessage(msg) {
        if (!msg.message_thread_id) return; // Ensure it's a topic message

        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            // Handle text message
            if (msg.text) {
                await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            } 
            // Handle media messages from Telegram
            else if (msg.photo && msg.photo.length > 0) {
                const fileId = msg.photo[msg.photo.length - 1].file_id; // Get the largest photo
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'image', msg.caption);
            } else if (msg.video) {
                const fileId = msg.video.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'video', msg.caption);
            } else if (msg.audio) {
                const fileId = msg.audio.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'audio', msg.caption);
            } else if (msg.document) {
                const fileId = msg.document.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'document', msg.caption, msg.document.file_name);
            } else if (msg.sticker) {
                const fileId = msg.sticker.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'sticker');
            } else if (msg.voice) {
                const fileId = msg.voice.file_id;
                // Telegram voice messages are typically OGG Opus, which WhatsApp can play as voice notes.
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'voice', msg.caption);
            } else if (msg.video_note) {
                const fileId = msg.video_note.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'video-note', msg.caption);
            } else {
                logger.warn('Received unhandled Telegram message type:', msg);
                return; // Do not send confirmation for unhandled types
            }
            
            // React with an emoji as confirmation
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, {
                emoji: '✅'
            });

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            // Optionally, send an error reaction
            await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, {
                emoji: '❌'
            }).catch(e => logger.error('Failed to send error reaction:', e.message));
        }
    }

    async sendMediaToWhatsApp(fileId, whatsappJid, type, caption = '', fileName = '') {
        try {
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            const mimeType = (await fromBuffer(buffer))?.mime;
            const mediaFileName = fileName || `${type}_${Date.now()}.${(await fromBuffer(buffer))?.ext}`;
            const filePath = path.join(this.mediaDownloadsDir, mediaFileName);
            await fs.writeFile(filePath, buffer);

            const message = { [type]: { url: filePath }, caption: caption };
            if (type === 'voice') {
                message.ptt = true; // Mark as voice message for WhatsApp
            }
            if (type === 'video-note') {
                // WhatsApp does not have a direct "video note" type, send as video
                message.video = { url: filePath };
                delete message['video-note']; // Remove the custom type
            }

            await this.whatsappBot.sendMessage(whatsappJid, message);
            await fs.unlink(filePath).catch(e => logger.error('Failed to delete temporary media file:', e.message)); // Clean up temp file

        } catch (error) {
            logger.error(`❌ Failed to send ${type} from Telegram to WhatsApp:`, error);
            throw error; // Re-throw to allow main handler to react
        }
    }

    async handleCallback(query) {
        const [action, data] = query.data.split('_');
        
        try {
            switch (action) {
                case 'info':
                    await this.handleInfoCallback(query, data);
                    break;
                // Removed 'reply' callback as it's no longer needed for direct replies
            }
        } catch (error) {
            logger.error('❌ Failed to handle callback:', error);
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: 'An error occurred.',
                show_alert: true
            });
        }
    }

    async handleInfoCallback(query, participantId) {
        const userInfo = this.userMappings.get(participantId);
        
        if (userInfo) {
            const infoText = `👤 User: ${userInfo.name}\n📱 Phone: ${userInfo.phone}\n👋 First Seen: ${userInfo.firstSeen.toLocaleString()}\n💬 Messages: ${userInfo.messageCount}`;
            
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: infoText,
                show_alert: true
            });
        } else {
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: '❌ User information not found',
                show_alert: true
            });
        }
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

    async handleProfilePictureUpdate(jid) {
        if (!this.telegramBot || !config.get('telegram.settings.autoUpdateProfilePics')) return;

        const topicId = this.chatMappings.get(jid);
        if (topicId) {
            await this.sendProfilePicture(topicId, jid);
        }
    }

    async handleCallUpdate(call) {
        if (!this.telegramBot || !config.get('telegram.settings.syncCalls')) return;

        const chatId = config.get('telegram.chatId');
        if (!chatId) return;

        let topicId;
        const callerJid = call.chatId || call.from; // Use chatId for group calls, 'from' for direct calls

        // Try to find existing topic or create a 'Calls' topic
        topicId = this.chatMappings.get(`calls_topic_${callerJid}`);
        if (!topicId) {
            try {
                const topicName = `📞 Call Logs (${callerJid.split('@')[0]})`;
                const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                    icon_color: 0xFF0000 // Red color for calls
                });
                topicId = topic.message_thread_id;
                this.chatMappings.set(`calls_topic_${callerJid}`, topicId);
                logger.info(`🆕 Created Telegram topic for calls: ${topicName} (ID: ${topicId})`);
            } catch (error) {
                logger.error('❌ Failed to create Telegram topic for calls:', error);
                // Fallback to sending to general log if topic creation fails
                await this.logToTelegram('📞 Call Log', `Call from ${callerJid}: ${call.status}`);
                return;
            }
        }

        const callStatusMap = {
            offer: 'Incoming Call',
            accept: 'Call Accepted',
            reject: 'Call Rejected',
            busy: 'Call Busy',
            timeout: 'Call Missed (Timeout)',
            end: 'Call Ended',
            terminate: 'Call Terminated',
            // Add other statuses as needed
        };

        const statusText = callStatusMap[call.status] || `Call Status: ${call.status}`;
        let messageText = `📞 *New Call Event*\n\n`;
        messageText += `*From*: ${callerJid.split('@')[0]}\n`;
        messageText += `*Status*: ${statusText}\n`;
        if (call.isVideo) {
            messageText += `*Type*: Video Call\n`;
        } else {
            messageText += `*Type*: Voice Call\n`;
        }
        messageText += `*Timestamp*: ${new Date(call.timestamp * 1000).toLocaleString()}\n`;

        await this.telegramBot.sendMessage(chatId, messageText, {
            message_thread_id: topicId,
            parse_mode: 'Markdown'
        });
    }

    async handleStatusUpdate(status) {
        if (!this.telegramBot || !config.get('telegram.settings.syncStatus')) return;

        const chatId = config.get('telegram.chatId');
        if (!chatId) return;

        let topicId;
        const senderJid = status.key.participant || status.key.remoteJid;

        // Try to find existing topic or create a 'Status Updates' topic
        topicId = this.chatMappings.get(`status_topic_${senderJid}`);
        if (!topicId) {
            try {
                const userInfo = this.userMappings.get(senderJid);
                const topicName = `👀 Status Updates (${userInfo ? userInfo.name : senderJid.split('@')[0]})`;
                const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                    icon_color: 0xF0B96F // Yellow/Orange for status
                });
                topicId = topic.message_thread_id;
                this.chatMappings.set(`status_topic_${senderJid}`, topicId);
                logger.info(`🆕 Created Telegram topic for status updates: ${topicName} (ID: ${topicId})`);
                await this.sendProfilePicture(topicId, senderJid); // Send profile pic when topic created
            } catch (error) {
                logger.error('❌ Failed to create Telegram topic for status updates:', error);
                // Fallback to sending to general log if topic creation fails
                await this.logToTelegram('👀 Status Update', `Status from ${senderJid}`);
                return;
            }
        }

        let messageText = `👀 *New Status Update*\n\n`;
        messageText += `*From*: ${senderJid.split('@')[0]}\n`;
        messageText += `*Timestamp*: ${new Date(status.messageTimestamp * 1000).toLocaleString()}\n\n`;

        if (status.message?.imageMessage) {
            messageText += `*Type*: Image Status\n`;
            const buffer = await this.whatsappBot.downloadMediaMessage(status);
            await this.telegramBot.sendPhoto(chatId, buffer, {
                message_thread_id: topicId,
                caption: messageText
            });
        } else if (status.message?.videoMessage) {
            messageText += `*Type*: Video Status\n`;
            const buffer = await this.whatsappBot.downloadMediaMessage(status);
            await this.telegramBot.sendVideo(chatId, buffer, {
                message_thread_id: topicId,
                caption: messageText
            });
        } else if (status.message?.extendedTextMessage) {
            messageText += `*Type*: Text Status\n`;
            messageText += `*Content*: ${status.message.extendedTextMessage.text}\n`;
            await this.telegramBot.sendMessage(chatId, messageText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } else {
            messageText += `*Type*: Unhandled Status Type\n`;
            await this.telegramBot.sendMessage(chatId, messageText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            logger.warn('Received unhandled WhatsApp status type for Telegram sync:', status.message);
        }
    }


    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
            logger.info('📱 Telegram bridge stopped');
        }
        // Clean up temporary media directory on shutdown
        await fs.rm(this.mediaDownloadsDir, { recursive: true, force: true })
            .then(() => logger.info('Cleaned up temporary media download directory.'))
            .catch(e => logger.error('Failed to clean up temporary media directory:', e.message));
    }
}

module.exports = TelegramBridge;
