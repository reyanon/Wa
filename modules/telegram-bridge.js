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
            // Only process messages from supergroups and if topics are enabled, or direct private messages to the bot.
            // This is crucial for handling replies within topics.
            if (config.get('telegram.useTopics') && msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            } else if (!config.get('telegram.useTopics') && msg.chat.type === 'supergroup') {
                // If topics are not used, handle messages in the main group chat
                logger.warn('⚠️ Telegram bridge is configured to use topics, but message is not a topic message. Skipping.');
                // You might want to implement a fallback here if useTopics is false
            } else if (msg.chat.type === 'private' && msg.from.id == this.telegramBot.options.token.split(':')[0]) {
                // Ignore messages from the bot itself
                return;
            } else if (msg.chat.type === 'private') {
                // Handle private messages to the bot, maybe for commands or specific user interactions
                logger.debug(`Received private Telegram message from ${msg.from.username || msg.from.first_name}: ${msg.text || '[Media]'}`);
                // Example: If user sends /start, you could reply with instructions
                // if (msg.text === '/start') {
                //     await this.telegramBot.sendMessage(msg.chat.id, 'Hello! I am your WhatsApp-Telegram bridge bot. Please use me in a group with topics enabled.');
                // }
            } else {
                 logger.debug('Received unhandled Telegram message (not supergroup topic or private chat):', msg);
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
        const participant = whatsappMsg.key.participant || sender; // For group messages, participant is the sender in the group
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg); // Use sender for topic mapping
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
                // Get contact info from WhatsApp sock
                const contact = await this.whatsappBot.sock.contacts[participant];
                if (contact) {
                    userName = contact.notify || contact.vname || contact.name || userPhone;
                } else {
                    // If contact not found, try fetching from WhatsApp server (might be slow)
                    const [result] = await this.whatsappBot.sock.onWhatsApp(userPhone);
                    if (result && result.exists) {
                         const fetchedContact = await this.whatsappBot.sock.fetchStatus(result.jid); // Fetches name too sometimes
                         if (fetchedContact && fetchedContact.name) {
                             userName = fetchedContact.name;
                         }
                    }
                }
            }
        } catch (error) {
            logger.debug(`Could not fetch contact info for ${participant}:`, error);
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
                    topicName = `📱 Group Chat (${chatJid.split('@')[0]})`; // Fallback to JID if name not found
                    logger.warn(`Could not get group metadata for ${chatJid}, using JID as topic name.`);
                }
            } else {
                const userInfo = this.userMappings.get(chatJid); // For private chats, chatJid is the participant
                if (userInfo && userInfo.name && userInfo.name !== 'Unknown User') {
                    topicName = `👤 ${userInfo.name} (${userInfo.phone})`;
                } else {
                    topicName = `👤 ${userInfo ? userInfo.phone : chatJid.split('@')[0]}`;
                }
            }

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message and profile picture if available
            await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup);
            await this.sendProfilePicture(topic.message_thread_id, chatJid); // Send PP for both group and private
            
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
        if (!config.get('telegram.settings.autoUpdateProfilePics')) return;

        const chatId = config.get('telegram.chatId');
        try {
            const ppUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            if (ppUrl) {
                // Download image and re-upload to Telegram for better reliability
                const response = await axios.get(ppUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);
                
                await this.telegramBot.sendPhoto(chatId, buffer, {
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
        // const userInfo = this.userMappings.get(participant); // Not used for simplified messages
        
        try {
            // No inline keyboard needed as per request for simplified messages
            const messageOptions = {
                message_thread_id: topicId,
                // parse_mode: 'Markdown' // Remove markdown parsing for simple text/media
            };

            if (text) {
                await this.telegramBot.sendMessage(chatId, text, messageOptions);
            } else if (whatsappMsg.message?.imageMessage && config.get('telegram.settings.allowMedia')) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendPhoto(chatId, buffer, messageOptions);
            } else if (whatsappMsg.message?.videoMessage && config.get('telegram.settings.allowVideos')) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendVideo(chatId, buffer, messageOptions);
            } else if (whatsappMsg.message?.audioMessage && config.get('telegram.settings.allowAudio')) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                const fileType = await fromBuffer(buffer);
                // WhatsApp PTT (Push-to-talk) audio messages should be sent as Telegram voice notes
                if (whatsappMsg.message.audioMessage.ptt || (fileType && fileType.ext === 'ogg' && fileType.mime === 'audio/ogg')) {
                    await this.telegramBot.sendVoice(chatId, buffer, messageOptions);
                } else {
                    await this.telegramBot.sendAudio(chatId, buffer, messageOptions);
                }
            } else if (whatsappMsg.message?.documentMessage && config.get('telegram.settings.allowDocuments')) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendDocument(chatId, buffer, {
                    ...messageOptions,
                    fileName: whatsappMsg.message.documentMessage.fileName || 'document'
                });
            } else if (whatsappMsg.message?.stickerMessage && config.get('telegram.settings.allowStickers')) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendSticker(chatId, buffer, messageOptions);
            } else if (whatsappMsg.message?.videoNoteMessage && config.get('telegram.settings.allowVideos')) {
                const buffer = await this.whatsappBot.downloadMediaMessage(whatsappMsg);
                await this.telegramBot.sendVideoNote(chatId, buffer, messageOptions);
            } else {
                logger.warn('Received unhandled or disallowed WhatsApp message type for Telegram sync:', whatsappMsg.message);
                // Optionally send a text message indicating unhandled type if desired
                // await this.telegramBot.sendMessage(chatId, 'Received an unhandled message type from WhatsApp.', messageOptions);
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
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message (Topic ID: %s)', topicId);
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not find corresponding WhatsApp chat for this topic.', {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id
                });
                return;
            }

            // Handle text message
            if (msg.text) {
                await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            } 
            // Handle media messages from Telegram
            else if (msg.photo && msg.photo.length > 0 && config.get('telegram.settings.allowMedia')) {
                const fileId = msg.photo[msg.photo.length - 1].file_id; // Get the largest photo
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'image', msg.caption);
            } else if (msg.video && config.get('telegram.settings.allowVideos')) {
                const fileId = msg.video.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'video', msg.caption);
            } else if (msg.audio && config.get('telegram.settings.allowAudio')) {
                const fileId = msg.audio.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'audio', msg.caption);
            } else if (msg.document && config.get('telegram.settings.allowDocuments')) {
                const fileId = msg.document.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'document', msg.caption, msg.document.file_name);
            } else if (msg.sticker && config.get('telegram.settings.allowStickers')) {
                const fileId = msg.sticker.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'sticker');
            } else if (msg.voice && config.get('telegram.settings.allowVoice')) {
                const fileId = msg.voice.file_id;
                // Telegram voice messages are typically OGG Opus, send as voice note for WhatsApp
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'voice', msg.caption);
            } else if (msg.video_note && config.get('telegram.settings.allowVideos')) {
                const fileId = msg.video_note.file_id;
                await this.sendMediaToWhatsApp(fileId, whatsappJid, 'video-note', msg.caption);
            } else {
                logger.warn('Received unhandled or disallowed Telegram message type:', msg);
                // Optionally react with a different emoji for unhandled types
                await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, {
                    emoji: '🤷‍♀️' // Shrug emoji for unhandled types
                }).catch(e => logger.error('Failed to send reaction:', e.message));
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

            const mimeTypeResult = await fromBuffer(buffer);
            const mimeType = mimeTypeResult?.mime;
            const fileExtension = mimeTypeResult?.ext;

            const mediaFileName = fileName || `${type}_${Date.now()}.${fileExtension || 'bin'}`;
            const filePath = path.join(this.mediaDownloadsDir, mediaFileName);
            await fs.writeFile(filePath, buffer);

            const message = {};
            if (type === 'image') {
                message.image = { url: filePath };
                if (caption) message.caption = caption;
            } else if (type === 'video') {
                message.video = { url: filePath };
                if (caption) message.caption = caption;
            } else if (type === 'audio') {
                message.audio = { url: filePath };
                if (caption) message.caption = caption;
            } else if (type === 'document') {
                message.document = { url: filePath };
                if (caption) message.caption = caption;
                message.fileName = fileName; // Ensure original filename is kept
            } else if (type === 'sticker') {
                message.sticker = { url: filePath };
            } else if (type === 'voice') {
                // For Telegram voice messages (ogg opus), send as WhatsApp voice message
                message.audio = { url: filePath };
                message.ptt = true; // Mark as voice message for WhatsApp
                if (caption) message.caption = caption;
            } else if (type === 'video-note') {
                // Telegram video notes are sent as normal videos to WhatsApp
                message.video = { url: filePath };
                if (caption) message.caption = caption;
            } else {
                logger.warn(`Attempted to send unhandled media type '${type}' to WhatsApp.`);
                await fs.unlink(filePath).catch(e => logger.error('Failed to delete unhandled temp media file:', e.message));
                return;
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
                // 'reply' callback is intentionally removed
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

    // This function needs to be called by your main bot when a profile picture update event occurs.
    async handleProfilePictureUpdate(jid) {
        if (!this.telegramBot || !config.get('telegram.settings.autoUpdateProfilePics')) return;

        const topicId = this.chatMappings.get(jid);
        if (topicId) {
            await this.sendProfilePicture(topicId, jid);
        } else {
            logger.debug(`No existing topic for JID ${jid} to send profile picture update.`);
            // Optionally create a topic if you want profile picture updates for unknown chats too
        }
    }

    // This function needs to be called by your main bot when a call event occurs.
    async handleCallUpdate(call) {
        if (!this.telegramBot || !config.get('telegram.settings.syncCalls')) return;

        const chatId = config.get('telegram.chatId');
        if (!chatId) return;

        let topicId;
        const callerJid = call.chatId || call.from; // Use chatId for group calls, 'from' for direct calls

        // Using a more robust key for call topics to avoid conflicts
        const callTopicKey = `_call_topic_${callerJid}`;
        topicId = this.chatMappings.get(callTopicKey);

        if (!topicId) {
            try {
                // Try to get user info for a more descriptive topic name
                let callerName = callerJid.split('@')[0];
                const userInfo = this.userMappings.get(callerJid);
                if (userInfo && userInfo.name && userInfo.name !== 'Unknown User') {
                    callerName = `${userInfo.name} (${userInfo.phone})`;
                } else if (userInfo) {
                    callerName = userInfo.phone;
                }
                
                const topicName = `📞 Call Logs (${callerName})`;
                const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                    icon_color: 0xFF0000 // Red color for calls
                });
                topicId = topic.message_thread_id;
                this.chatMappings.set(callTopicKey, topicId);
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

    // This function needs to be called by your main bot when a status update event occurs.
    async handleStatusUpdate(status) {
        if (!this.telegramBot || !config.get('telegram.settings.syncStatus')) return;

        const chatId = config.get('telegram.chatId');
        if (!chatId) return;

        let topicId;
        const senderJid = status.key.participant || status.key.remoteJid;

        // Using a more robust key for status topics
        const statusTopicKey = `_status_topic_${senderJid}`;
        topicId = this.chatMappings.get(statusTopicKey);

        if (!topicId) {
            try {
                let senderName = senderJid.split('@')[0];
                const userInfo = this.userMappings.get(senderJid);
                if (userInfo && userInfo.name && userInfo.name !== 'Unknown User') {
                    senderName = `${userInfo.name} (${userInfo.phone})`;
                } else if (userInfo) {
                    senderName = userInfo.phone;
                }

                const topicName = `👀 Status Updates (${senderName})`;
                const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                    icon_color: 0xF0B96F // Yellow/Orange for status
                });
                topicId = topic.message_thread_id;
                this.chatMappings.set(statusTopicKey, topicId);
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

        const messageOptions = {
            message_thread_id: topicId,
            parse_mode: 'Markdown'
        };

        if (status.message?.imageMessage && config.get('telegram.settings.allowMedia')) {
            messageText += `*Type*: Image Status\n`;
            const buffer = await this.whatsappBot.downloadMediaMessage(status);
            await this.telegramBot.sendPhoto(chatId, buffer, {
                ...messageOptions,
                caption: messageText
            });
        } else if (status.message?.videoMessage && config.get('telegram.settings.allowVideos')) {
            messageText += `*Type*: Video Status\n`;
            const buffer = await this.whatsappBot.downloadMediaMessage(status);
            await this.telegramBot.sendVideo(chatId, buffer, {
                ...messageOptions,
                caption: messageText
            });
        } else if (status.message?.extendedTextMessage) {
            messageText += `*Type*: Text Status\n`;
            messageText += `*Content*: ${status.message.extendedTextMessage.text}\n`;
            await this.telegramBot.sendMessage(chatId, messageText, messageOptions);
        } else {
            messageText += `*Type*: Unhandled Status Type\n`;
            await this.telegramBot.sendMessage(chatId, messageText, messageOptions);
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
