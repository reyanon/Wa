const TelegramBot = require('node-telegram-bot-api');
const TelegramCommands = require('./commands'); // Ensure this path is correct
const config = require('../config');
const logger = require('./logger');
// const { connectDb, closeDb } = require('./db'); // DB imports are handled by AdvancedWhatsAppBot
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp'); // For image/sticker processing
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Simple queue mechanism for outgoing Telegram messages to prevent race conditions
const telegramMessageQueue = [];
let isSendingTelegramMessage = false;

async function processTelegramMessageQueue() {
    if (isSendingTelegramMessage || telegramMessageQueue.length === 0) {
        return;
    }
    isSendingTelegramMessage = true;
    const { chatId, message, options, resolve, reject } = telegramMessageQueue.shift();
    try {
        const sentMsg = await this.telegramBot.sendMessage(chatId, message, options);
        resolve(sentMsg);
    } catch (error) {
        reject(error);
    } finally {
        isSendingTelegramMessage = false;
        processTelegramMessageQueue.call(this); // Process next message
    }
}

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.commands = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // Telegram User ID -> WhatsApp JID (for private chats with bot)
        this.contactMappings = new Map(); // WhatsApp JID -> Contact Name (for display)
        this.profilePicCache = new Map(); // JID -> Base64/Buffer (for Telegram display)
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessingWhatsAppMessage = false; // Flag to prevent concurrent WhatsApp message processing
        this.activeCallNotifications = new Map(); // Store ongoing call notifications
        this.statusMessageIds = new Map(); // For managing status messages
        this.presenceTimeout = null;
        this.botChatId = null; // Telegram chat ID for direct bot interactions (often owner's private chat)
        this.db = null; // MongoDB database instance (will be set by initialize)
        this.collections = {}; // To hold references to MongoDB collections
        this.startTime = Date.now(); // For uptime
        this.bridgeActive = true; // Bridge starts as active by default
    }

    async initialize(dbInstance) {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId');
        
        if (!token || token.includes('YOUR_BOT_TOKEN') || !chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly. Bridging will not start.');
            return;
        }

        try {
            this.db = dbInstance; // Use the pre-connected DB instance
            if (!this.db) {
                logger.error('❌ Database instance not provided to TelegramBridge. Exiting initialization.');
                return;
            }

            // Define collections (ensure these match names used in commands.js and db.js)
            this.collections.chatMappings = this.db.collection('chat_mappings'); // Renamed from telegram_chat_mappings for consistency
            this.collections.userMappings = this.db.collection('user_mappings'); // Renamed from telegram_user_mappings
            this.collections.contactMappings = this.db.collection('contact_mappings'); // Renamed from telegram_contact_mappings
            this.collections.bridgeSettings = this.db.collection('bridge_settings'); // Assuming this is for general settings, not just Telegram

            // Ensure indexes for performance (add if not already present in db.js's connectDb)
            await this.collections.chatMappings.createIndex({ whatsappJid: 1 }, { unique: true }).catch(() => {});
            await this.collections.userMappings.createIndex({ telegramUserId: 1 }, { unique: true }).catch(() => {}); // Changed to telegramUserId
            await this.collections.contactMappings.createIndex({ whatsappJid: 1 }, { unique: true }).catch(() => {}); // Changed to whatsappJid

            logger.info('📊 MongoDB collections initialized in TelegramBridge.');

            await this.loadMappingsFromDb();
            logger.info(`Loaded ${this.chatMappings.size} chat mappings, ${this.userMappings.size} user mappings, ${this.contactMappings.size} contact mappings from DB.`);

            this.telegramBot = new TelegramBot(token, { polling: true });
            logger.info('✅ Telegram bot initialized.');

            // Initialize commands, passing the bridge instance (which holds the DB reference)
            this.commands = new TelegramCommands(this); 
            logger.info('✅ Telegram commands initialized.');

            this.setupTelegramHandlers();
            this.setupWhatsAppHandlers();

            const webhookUrl = config.get('telegram.webhookUrl');
            if (webhookUrl) {
                await this.telegramBot.setWebhook(webhookUrl);
                logger.info(`🌍 Telegram webhook set to ${webhookUrl}`);
            }

            await fs.ensureDir(this.tempDir);
            await this.syncContacts();
            
            logger.info('🚀 Telegram bridge initialized and ready.');

        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error.message || error);
        }
    }

    async loadMappingsFromDb() {
        try {
            const chatMaps = await this.collections.chatMappings.find({}).toArray();
            this.chatMappings.clear();
            chatMaps.forEach(map => this.chatMappings.set(map.whatsappJid, map.telegramTopicId));

            const userMaps = await this.collections.userMappings.find({}).toArray();
            this.userMappings.clear();
            userMaps.forEach(map => this.userMappings.set(map.telegramUserId, map.whatsappJid)); // Assuming telegramUserId is key here

            const contactMaps = await this.collections.contactMappings.find({}).toArray();
            this.contactMappings.clear();
            contactMaps.forEach(map => this.contactMappings.set(map.whatsappJid, { name: map.name, number: map.number }));
        } catch (error) {
            logger.error('❌ Error loading mappings from database:', error);
        }
    }

    async saveChatMapping(whatsappJid, telegramTopicId) {
        try {
            await this.collections.chatMappings.updateOne(
                { whatsappJid: whatsappJid },
                { $set: { whatsappJid: whatsappJid, telegramTopicId: telegramTopicId, updatedAt: new Date() } },
                { upsert: true }
            );
            this.chatMappings.set(whatsappJid, telegramTopicId);
            logger.debug(`Saved chat mapping: ${whatsappJid} -> ${telegramTopicId}`);
        } catch (error) {
            logger.error(`❌ Error saving chat mapping for ${whatsappJid}:`, error);
        }
    }

    async saveUserMapping(telegramUserId, whatsappJid) {
        try {
            // Note: In your comands.js, you save userMappings as telegramUserId -> whatsappJid
            // In bridge.js (previous), it was whatsappId -> {name, phone, ...}
            // Let's standardize to telegramUserId -> whatsappJid as it's used for reverse lookup in Telegram handling.
            await this.collections.userMappings.updateOne(
                { telegramUserId: telegramUserId },
                { $set: { telegramUserId: telegramUserId, whatsappJid: whatsappJid, updatedAt: new Date() } },
                { upsert: true }
            );
            this.userMappings.set(telegramUserId, whatsappJid);
            logger.debug(`Saved user mapping: ${telegramUserId} -> ${whatsappJid}`);
        } catch (error) {
            logger.error(`❌ Error saving user mapping for ${telegramUserId}:`, error);
        }
    }

    async saveContactMapping(whatsappJid, name, number) {
        try {
            await this.collections.contactMappings.updateOne(
                { whatsappJid: whatsappJid },
                { $set: { whatsappJid: whatsappJid, name: name, number: number, updatedAt: new Date() } },
                { upsert: true }
            );
            this.contactMappings.set(whatsappJid, { name: name, number: number });
            logger.debug(`Saved contact mapping: ${whatsappJid} -> ${name} (${number})`);
        } catch (error) {
            logger.error(`❌ Error saving contact mapping for ${whatsappJid}:`, error);
        }
    }

    async getContactDisplayName(jid) {
        const contact = this.contactMappings.get(jid);
        if (contact?.name) {
            return contact.name;
        }

        // Attempt to get from WhatsApp directly if not in cache or name is missing
        try {
            const waContact = await this.whatsappBot.sock.contacts?.[jid];
            if (waContact) {
                const name = waContact.name || waContact.verifiedName || waContact.notify;
                if (name) {
                    await this.saveContactMapping(jid, name, jid.split('@')[0]); // Save for future use
                    return name;
                }
            }
        } catch (e) {
            logger.debug(`Could not get contact name for ${jid} from WhatsApp store: ${e.message}`);
        }

        // Fallback to number if no name is found
        return jid.split('@')[0];
    }

    async getOrCreateTopic(whatsappJid, { initialPushName = '', isGroup = false } = {}) {
        const telegramChatId = config.get('telegram.chatId');
        if (!telegramChatId) {
            logger.warn('⚠️ Telegram target chat ID not set. Cannot create or retrieve topic.');
            return null;
        }

        let topicId = this.chatMappings.get(whatsappJid);

        let displayName = await this.getContactDisplayName(whatsappJid);
        if (!displayName && initialPushName) {
            displayName = initialPushName;
        }
        if (!displayName) { // Final fallback
            displayName = whatsappJid.split('@')[0];
        }

        if (!topicId) {
            logger.info(`Creating new topic for ${displayName} (${whatsappJid})...`);
            try {
                const topic = await this.telegramBot.createForumTopic(telegramChatId, displayName);
                topicId = topic.message_thread_id;
                await this.saveChatMapping(whatsappJid, topicId);
                logger.info(`🎉 Created new topic "${displayName}" (ID: ${topicId}) for ${whatsappJid}`);
                
                await this.queueTelegramMessage(telegramChatId, 
                    `🔗 New chat linked: *${displayName}* (${whatsappJid})\n\n` +
                    `Messages sent here will go to WhatsApp.`,
                    { message_thread_id: topicId, parse_mode: 'Markdown' }
                );

            } catch (error) {
                logger.error(`❌ Failed to create Telegram topic for ${whatsappJid}:`, error.message || error);
                if (error.response?.body?.description) {
                    if (error.response.body.description.includes('forum topic support is not enabled')) {
                        logger.error('❗️ Telegram group does not have forum topics enabled. Please enable them in group settings.');
                        await this.queueTelegramMessage(this.botChatId || telegramChatId, '❌ Failed to create topic: Forum topic support is not enabled in the main Telegram group. Please enable it in group settings.', { parse_mode: 'Markdown' });
                    } else if (error.response.body.description.includes('FORUM_BOT_NOT_AN_ADMIN')) {
                         logger.error('❗️ Telegram bot is not an admin in the main group, or lacks necessary permissions to manage topics.');
                         await this.queueTelegramMessage(this.botChatId || telegramChatId, '❌ Failed to create topic: Telegram bot is not an admin in the main group or lacks necessary permissions (e.g., manage topics).', { parse_mode: 'Markdown' });
                    }
                }
                return null;
            }
        } else {
            // Update topic name if contact name has changed
            const currentTopicName = await this.getContactDisplayName(whatsappJid);
            if (currentTopicName && currentTopicName !== displayName) { 
                try {
                    await this.telegramBot.editForumTopic(telegramChatId, topicId, { name: currentTopicName });
                    logger.debug(`📝 Updated topic name for ${whatsappJid} to ${currentTopicName}`);
                } catch (error) {
                    logger.debug(`Could not update topic name for ${whatsappJid}: ${error.message}`);
                }
            }
        }
        return topicId;
    }

    async handleIncomingWhatsAppMessage(msg) {
        // Simple message queuing to prevent concurrent processing
        if (this.isProcessingWhatsAppMessage) {
            logger.debug('Skipping WhatsApp message due to ongoing processing.');
            return;
        }
        this.isProcessingWhatsAppMessage = true;

        try {
            if (!this.bridgeActive) {
                logger.debug('Telegram bridge is inactive, skipping WhatsApp message.');
                return;
            }

            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) {
                logger.warn('⚠️ Telegram target chat ID not set. Cannot forward WhatsApp message.');
                return;
            }
            
            const { messages } = msg;
            if (!messages || messages.length === 0) return;

            for (const m of messages) {
                if (!m.message) continue;

                const senderJid = m.key.participant || m.key.remoteJid; 
                const remoteJid = m.key.remoteJid; 
                const isGroup = remoteJid.endsWith('@g.us');
                
                // FIX: Correctly determine JID for topic creation for "fromMe" messages
                // If it's a message from the bot's own number, and it's a private chat,
                // the topic should be for the *remoteJid* (the person the bot sent to), not the bot's own JID.
                const whatsappJidForTopic = m.key.fromMe && !isGroup ? remoteJid : senderJid;

                const senderName = m.pushName || (await this.getContactDisplayName(senderJid)); 

                const telegramTopicId = await this.getOrCreateTopic(whatsappJidForTopic, { 
                    initialPushName: m.pushName, 
                    isGroup: isGroup 
                });

                if (!telegramTopicId) {
                    logger.error(`❌ Could not get/create Telegram topic for WhatsApp JID: ${whatsappJidForTopic}`);
                    continue;
                }

                let messageContent = '';
                let mediaType = null;
                let fileBuffer = null;
                let fileName = '';
                let mimeType = '';
                let caption = '';

                const message = m.message;
                if (message.conversation || message.extendedTextMessage?.text) {
                    messageContent = message.conversation || message.extendedTextMessage.text;
                    if (!m.key.fromMe) { 
                        messageContent = `*${senderName}:* ${messageContent}`;
                    }
                } else if (message.imageMessage) {
                    mediaType = 'photo';
                    caption = message.imageMessage.caption || '';
                    fileBuffer = await downloadContentFromMessage(message.imageMessage, 'image');
                    mimeType = message.imageMessage.mimetype;
                    fileName = `${m.key.id}.${mime.extension(mimeType)}`;
                    messageContent = `🖼️ *${senderName}* (Image)`;
                } else if (message.videoMessage) {
                    mediaType = 'video';
                    caption = message.videoMessage.caption || '';
                    fileBuffer = await downloadContentFromMessage(message.videoMessage, 'video');
                    mimeType = message.videoMessage.mimetype;
                    fileName = `${m.key.id}.${mime.extension(mimeType)}`;
                    messageContent = `📹 *${senderName}* (Video)`;

                    // FIX: Handle Video Notes (videoMessage with ptt: true and short duration)
                    if (message.videoMessage.seconds <= 60 && message.videoMessage.ptt) { 
                        mediaType = 'video_note';
                        messageContent = `🎥 *${senderName}* (Video Note)`;
                    }
                } else if (message.audioMessage) {
                    mediaType = 'audio';
                    fileBuffer = await downloadContentFromMessage(message.audioMessage, 'audio');
                    mimeType = message.audioMessage.mimetype;
                    fileName = `${m.key.id}.${mime.extension(mimeType)}`;
                    messageContent = `🎵 *${senderName}* (Audio)`;
                    if (message.audioMessage.ptt) { 
                        mediaType = 'voice';
                        messageContent = `🎤 *${senderName}* (Voice Message)`;
                    }
                } else if (message.documentMessage) {
                    mediaType = 'document';
                    caption = message.documentMessage.caption || '';
                    fileBuffer = await downloadContentFromMessage(message.documentMessage, 'document');
                    mimeType = message.documentMessage.mimetype;
                    fileName = message.documentMessage.fileName || `${m.key.id}.${mime.extension(mimeType)}`;
                    messageContent = `📄 *${senderName}* (Document: ${fileName})`;
                } else if (message.stickerMessage) {
                    mediaType = 'sticker';
                    fileBuffer = await downloadContentFromMessage(message.stickerMessage, 'sticker');
                    mimeType = message.stickerMessage.mimetype;
                    fileName = `${m.key.id}.${mime.extension(mimeType)}`;
                    messageContent = `✨ *${senderName}* (Sticker)`;
                } else if (message.locationMessage) {
                    mediaType = 'location';
                    const { degreesLatitude, degreesLongitude } = message.locationMessage;
                    messageContent = `📍 *${senderName}* (Location: ${degreesLatitude}, ${degreesLongitude})`;
                    try {
                        await this.queueTelegramMessage(telegramChatId, null, { // Send location separately
                            message_thread_id: telegramTopicId,
                            latitude: degreesLatitude,
                            longitude: degreesLongitude,
                            type: 'location'
                        });
                        await this.queueTelegramMessage(telegramChatId, messageContent, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                        continue; 
                    } catch (error) {
                        logger.error(`❌ Failed to send location to Telegram:`, error);
                    }
                } else if (message.contactMessage) {
                    mediaType = 'contact';
                    const displayName = message.contactMessage.displayName;
                    const vcard = message.contactMessage.vcard;
                    messageContent = `👤 *${senderName}* (Contact: ${displayName})`;
                    try {
                        await this.queueTelegramMessage(telegramChatId, null, { // Send contact separately
                            message_thread_id: telegramTopicId,
                            contact: { phone_number: vcard.match(/TEL.*:(.*)/)?.[1], first_name: displayName, vcard: vcard }, // Simplified contact object for sendContact
                            type: 'contact'
                        });
                        await this.queueTelegramMessage(telegramChatId, messageContent, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                        continue; 
                    } catch (error) {
                        logger.error(`❌ Failed to send contact to Telegram:`, error);
                    }
                } else {
                    logger.warn('⚠️ Unhandled WhatsApp message type:', message);
                    messageContent = `❓ *${senderName}* (Unsupported message type)`;
                }

                try {
                    if (fileBuffer) {
                        const filePath = path.join(this.tempDir, fileName);
                        await fs.outputFile(filePath, fileBuffer);

                        const telegramSendOptions = {
                            message_thread_id: telegramTopicId,
                            parse_mode: 'Markdown',
                            caption: `${messageContent}${caption ? '\n' + caption : ''}`
                        };

                        switch (mediaType) {
                            case 'photo':
                                await this.queueTelegramMessage(telegramChatId, null, { ...telegramSendOptions, file: filePath, type: 'photo' });
                                break;
                            case 'video':
                                await this.queueTelegramMessage(telegramChatId, null, { ...telegramSendOptions, file: filePath, type: 'video' });
                                break;
                            case 'video_note': 
                                await this.queueTelegramMessage(telegramChatId, null, { ...telegramSendOptions, file: filePath, type: 'video_note' });
                                if (telegramSendOptions.caption) {
                                     await this.queueTelegramMessage(telegramChatId, telegramSendOptions.caption, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                                }
                                break;
                            case 'audio':
                                await this.queueTelegramMessage(telegramChatId, null, { ...telegramSendOptions, file: filePath, type: 'audio' });
                                break;
                            case 'voice': 
                                await this.queueTelegramMessage(telegramChatId, null, { ...telegramSendOptions, file: filePath, type: 'voice' });
                                if (telegramSendOptions.caption) {
                                     await this.queueTelegramMessage(telegramChatId, telegramSendOptions.caption, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                                }
                                break;
                            case 'document':
                                await this.queueTelegramMessage(telegramChatId, null, { ...telegramSendOptions, file: filePath, fileName: fileName, type: 'document' });
                                break;
                            case 'sticker':
                                // FIX: Send stickers directly as stickers if possible, otherwise convert to PNG
                                try {
                                    await this.queueTelegramMessage(telegramChatId, null, { message_thread_id: telegramTopicId, file: filePath, type: 'sticker' });
                                } catch (stickerError) {
                                    logger.warn('Failed to send WhatsApp sticker as sticker, trying PNG fallback:', stickerError.message);
                                    const pngPath = filePath.replace('.webp', '.png');
                                    await sharp(fileBuffer).png().toFile(pngPath); // Convert buffer to PNG
                                    await this.queueTelegramMessage(telegramChatId, null, { message_thread_id: telegramTopicId, file: pngPath, type: 'photo', caption: 'Sticker (as image)' });
                                    await fs.remove(pngPath).catch(() => {});
                                }
                                break;
                        }
                        await fs.remove(filePath); // Clean up temp file
                    } else if (messageContent) {
                        await this.queueTelegramMessage(telegramChatId, messageContent, {
                            message_thread_id: telegramTopicId,
                            parse_mode: 'Markdown'
                        });
                    }
                } catch (error) {
                    logger.error(`❌ Error forwarding WhatsApp message to Telegram for ${whatsappJidForTopic}:`, error.message || error);
                    if (messageContent) {
                        await this.queueTelegramMessage(telegramChatId, `⚠️ Error forwarding message from WhatsApp (from ${senderName}): ${error.message}\n\nOriginal content: ${messageContent}`, {
                            message_thread_id: telegramTopicId,
                            parse_mode: 'Markdown'
                        });
                    }
                }
            }
        } finally {
            this.isProcessingWhatsAppMessage = false;
        }
    }

    // New Queuing mechanism for Telegram messages
    async queueTelegramMessage(chatId, message, options = {}) {
        return new Promise((resolve, reject) => {
            telegramMessageQueue.push({ chatId, message, options, resolve, reject });
            processTelegramMessageQueue.call(this); // Start processing if not already
        });
    }


    async handleIncomingTelegramMessage(msg) {
        if (!this.bridgeActive) {
            logger.debug('Telegram bridge is inactive, skipping Telegram message.');
            return;
        }

        const telegramChatId = config.get('telegram.chatId');
        if (msg.chat.id.toString() !== telegramChatId) {
            if (!msg.text || !msg.text.startsWith('/')) {
                logger.debug(`Ignoring message from non-target chat: ${msg.chat.id}`);
                return;
            }
        }

        const telegramTopicId = msg.message_thread_id; 
        const isReply = msg.reply_to_message;

        let targetWhatsappJid = null;
        if (telegramTopicId) {
            targetWhatsappJid = this.findWhatsAppJidByTopic(telegramTopicId);
        } else if (msg.chat.type === 'private' && this.commands.isOwner(msg.from.id)) {
             targetWhatsappJid = await this.collections.userMappings.findOne({ telegramUserId: msg.from.id })?.whatsappJid;
             if (!targetWhatsappJid) {
                targetWhatsappJid = config.get('bot.owner'); // Use config's owner WA JID
             }
        }

        if (!targetWhatsappJid) {
            logger.warn(`⚠️ Could not determine target WhatsApp JID for Telegram message from chat ${msg.chat.id}, topic ${telegramTopicId}.`);
            if (msg.chat.type !== 'private' && telegramTopicId) { 
                await this.queueTelegramMessage(msg.chat.id, '❌ Could not find a linked WhatsApp chat for this topic.', { message_thread_id: telegramTopicId });
            } else if (msg.chat.type === 'private' && this.commands.isOwner(msg.from.id)) { 
                 await this.queueTelegramMessage(msg.chat.id, '❌ Could not find a linked WhatsApp chat for this message. Use /send <number> <message> to initiate or respond in a bridged topic.', { parse_mode: 'Markdown' });
            }
            return;
        }

        let fileUrl = null;
        let fileName = '';
        let mediaType = null; // Used to identify media for Baileys send
        let mimeType = '';
        let caption = msg.caption || '';


        if (msg.text) {
            if (telegramTopicId && isReply) {
                 // Check if it's a reply to a WA message forwarded by the bot
                 // This is already covered by targetWhatsappJid logic above
            } else if (msg.chat.type === 'private' && this.commands.isOwner(msg.from.id)) {
                // Direct message from owner
            } else {
                logger.debug(`Ignoring non-reply text message in bridged group/topic from ${msg.from.id}: ${msg.text}`);
                return; 
            }
            // Send text message
            const sendResult = await this.whatsappBot.sendMessage(targetWhatsappJid, { text: msg.text });
            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
            } else {
                await this.setReaction(msg.chat.id, msg.message_id, '🤷‍♂️'); // No confirmation emoji
            }
            return; // Text message handled, exit
        } 
        
        // Handle media messages
        if (msg.photo && msg.photo.length > 0) {
            mediaType = 'image';
            const photo = msg.photo[msg.photo.length - 1]; 
            fileUrl = await this.telegramBot.getFileLink(photo.file_id);
            mimeType = 'image/jpeg'; 
            fileName = `telegram_photo_${msg.message_id}.jpeg`;
        } else if (msg.video) {
            mediaType = 'video';
            fileUrl = await this.telegramBot.getFileLink(msg.video.file_id);
            mimeType = msg.video.mime_type;
            fileName = `telegram_video_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.audio) {
            mediaType = 'audio';
            fileUrl = await this.telegramBot.getFileLink(msg.audio.file_id);
            mimeType = msg.audio.mime_type;
            fileName = `telegram_audio_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.voice) { 
            mediaType = 'voice';
            fileUrl = await this.telegramBot.getFileLink(msg.voice.file_id);
            mimeType = msg.voice.mime_type; 
            fileName = `telegram_voice_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.document) {
            mediaType = 'document';
            fileUrl = await this.telegramBot.getFileLink(msg.document.file_id);
            mimeType = msg.document.mime_type;
            fileName = msg.document.file_name || `telegram_document_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.sticker) { 
            mediaType = 'sticker';
            fileUrl = await this.telegramBot.getFileLink(msg.sticker.file_id);
            mimeType = msg.sticker.mime_type; 
            fileName = `telegram_sticker_${msg.message_id}.${mime.extension(mimeType) || 'webp'}`;
        } else if (msg.location) {
            try {
                await this.whatsappBot.sendMessage(targetWhatsappJid, {
                    location: { degreesLatitude: msg.location.latitude, degreesLongitude: msg.location.longitude }
                });
                logger.info(`📍 Forwarded Telegram location to ${targetWhatsappJid}`);
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
            } catch (error) {
                logger.error(`❌ Failed to forward Telegram location:`, error);
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
            }
            return; 
        } else if (msg.contact) {
            try {
                const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${msg.contact.first_name} ${msg.contact.last_name || ''}\nTEL;TYPE=CELL:${msg.contact.phone_number}\nEND:VCARD`;
                await this.whatsappBot.sendMessage(targetWhatsappJid, {
                    contacts: {
                        displayName: `${msg.contact.first_name} ${msg.contact.last_name || ''}`,
                        contacts: [{ vcard }]
                    }
                });
                logger.info(`👤 Forwarded Telegram contact to ${targetWhatsappJid}`);
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
            } catch (error) {
                logger.error(`❌ Failed to forward Telegram contact:`, error);
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
            }
            return; 
        } else if (msg.video_note) { 
            mediaType = 'video_note';
            fileUrl = await this.telegramBot.getFileLink(msg.video_note.file_id);
            mimeType = msg.video_note.mime_type; 
            fileName = `telegram_videonote_${msg.message_id}.${mime.extension(mimeType) || 'mp4'}`;
        } else {
            logger.warn('⚠️ Unhandled Telegram message type:', msg);
            await this.setReaction(msg.chat.id, msg.message_id, '❓'); // Unknown type emoji
            return; 
        }

        // --- Handle Media File Download and Forward ---
        if (fileUrl && mediaType) {
            let sendResult;
            try {
                const response = await axios({
                    method: 'get',
                    url: fileUrl,
                    responseType: 'arraybuffer'
                });
                let fileBuffer = Buffer.from(response.data);
                const filePath = path.join(this.tempDir, fileName);

                let messageOptions = { caption: caption || undefined };

                switch (mediaType) {
                    case 'image':
                        await fs.outputFile(filePath, fileBuffer); // Save original
                        messageOptions.image = { url: filePath };
                        break;
                    case 'video':
                    case 'video_note': // Treat video notes as regular videos for sending
                        await fs.outputFile(filePath, fileBuffer); // Save original
                        messageOptions.video = { url: filePath };
                        break;
                    case 'audio':
                        await fs.outputFile(filePath, fileBuffer); // Save original
                        messageOptions.audio = { url: filePath };
                        messageOptions.mimetype = mimeType;
                        break;
                    case 'voice':
                        await fs.outputFile(filePath, fileBuffer); // Save original
                        messageOptions.audio = { url: filePath };
                        messageOptions.mimetype = 'audio/ogg; codecs=opus'; // Specific for WA voice notes
                        messageOptions.ptt = true;
                        break;
                    case 'document':
                        await fs.outputFile(filePath, fileBuffer); // Save original
                        messageOptions.document = { url: filePath };
                        messageOptions.fileName = fileName;
                        messageOptions.mimetype = mimeType;
                        break;
                    case 'sticker':
                        // FIX: Attempt to convert sticker for WhatsApp compatibility
                        const stickerOutputPath = path.join(this.tempDir, `wa_sticker_${msg.message_id}.webp`);
                        try {
                             await sharp(fileBuffer)
                                .resize(512, 512, {
                                    fit: sharp.fit.contain,
                                    background: { r: 0, g: 0, b: 0, alpha: 0 } // Transparent background
                                })
                                .webp({ lossless: true, quality: 100 }) // Ensure high quality webp
                                .toFile(stickerOutputPath);

                            messageOptions.sticker = { url: stickerOutputPath };
                        } catch (conversionError) {
                            logger.error(`❌ Sticker conversion failed for ${fileName}:`, conversionError);
                            // Fallback to sending as image if conversion fails
                            const imageFallbackPath = path.join(this.tempDir, `wa_sticker_fallback_${msg.message_id}.png`);
                            await sharp(fileBuffer).png().toFile(imageFallbackPath);
                            messageOptions.image = { url: imageFallbackPath };
                            messageOptions.caption = 'Sticker (sent as image)';
                            logger.warn(`⚠️ Sending sticker ${fileName} as image fallback.`);
                        }
                        break;
                }

                sendResult = await this.whatsappBot.sendMessage(targetWhatsappJid, messageOptions);
                
                // Clean up temp files
                await fs.remove(filePath).catch(() => {});
                if (mediaType === 'sticker' && stickerOutputPath) {
                    await fs.remove(stickerOutputPath).catch(() => {});
                }
                if (mediaType === 'sticker' && messageOptions.image?.url) { // Fallback image cleanup
                    await fs.remove(messageOptions.image.url).catch(() => {});
                }

                if (sendResult?.key?.id) {
                    logger.info(`✅ Successfully sent Telegram ${mediaType} to ${targetWhatsappJid}`);
                    await this.setReaction(msg.chat.id, msg.message_id, '👍');
                } else {
                    logger.warn(`⚠️ Failed to send Telegram ${mediaType} to WhatsApp - no message ID returned`);
                    await this.setReaction(msg.chat.id, msg.message_id, '🤷‍♂️');
                }

            } catch (error) {
                logger.error(`❌ Failed to forward Telegram ${mediaType} to ${targetWhatsappJid}:`, error.message || error);
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
                await this.queueTelegramMessage(msg.chat.id, `❌ Failed to send ${mediaType} to WhatsApp: ${error.message}`, { message_thread_id: telegramTopicId });
            }
        }
    }

    // Reaction confirmation logic
    async setReaction(chatId, messageId, emoji) {
        if (!config.get('features.reactionConfirmation')) { // Check if feature is enabled
            logger.debug('Reaction confirmation feature is disabled, skipping.');
            return;
        }
        try {
            await this.telegramBot.setMessageReaction(chatId, messageId, {
                reaction: [{ type: 'emoji', emoji: emoji }]
            });
        } catch (err) {
            logger.debug(`❌ Failed to set reaction (${emoji}) on message ${messageId} in chat ${chatId}:`, err.message);
        }
    }

    setupTelegramHandlers() {
        this.telegramBot.on('message', async (msg) => {
            if (msg.from.id === this.telegramBot.options.id) {
                return;
            }
            if (msg.text && msg.text.startsWith('/')) {
                // Commands are handled by TelegramCommands, let it decide.
                // However, the `wrapCommand` in TelegramCommands filters non-owner commands.
                // This `on('message')` handler is for non-command messages.
                // So, if it's a command, let's explicitly skip this part.
                return; 
            }
            await this.handleIncomingTelegramMessage(msg);
        });

        this.telegramBot.on('polling_error', (error) => {
            logger.error(`❌ Telegram polling error: ${error.code} - ${error.message}`);
        });

        this.telegramBot.on('error', (error) => {
            logger.error(`❌ Telegram bot error: ${error.code} - ${error.message}`);
        });
        logger.info('📱 Telegram event handlers set up.');
    }

    setupWhatsAppHandlers() {
        const sock = this.whatsappBot.sock;

        sock.ev.on('messages.upsert', async (m) => {
            // FIX: Process ALL incoming messages, including those sent by yourself (fromMe),
            // as they might be initial messages to new contacts that need topic creation.
            // The `handleIncomingWhatsAppMessage` will internally handle if it should be prefixed.
            await this.handleIncomingWhatsAppMessage(m);
        });

        // RE-ADDED: Message Update Listener (for reactions)
        sock.ev.on('messages.update', async (updates) => {
            if (!config.get('features.reactionConfirmation')) {
                logger.debug('Reaction confirmation feature is disabled.');
                return;
            }
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) {
                logger.warn('⚠️ Telegram target chat ID not set. Cannot forward reaction.');
                return;
            }

            for (const update of updates) {
                if (update.update && update.update.reactions && update.update.reactions.length > 0) {
                    const reaction = update.update.reactions[0]; 
                    const remoteJid = reaction.key.remoteJid; 
                    const reactorJid = reaction.key.participant || remoteJid; 

                    const topicId = this.chatMappings.get(remoteJid);
                    if (!topicId) {
                        logger.debug(`Ignoring reaction for non-bridged chat: ${remoteJid}`);
                        continue;
                    }

                    const reactorName = await this.getContactDisplayName(reactorJid);
                    const emoji = reaction.text;
                    
                    let reactionMessage = '';
                    if (emoji) {
                        reactionMessage = `*${reactorName}* reacted with ${emoji}`;
                    } else {
                        reactionMessage = `*${reactorName}* removed a reaction`;
                    }
                    
                    try {
                        await this.queueTelegramMessage(telegramChatId, reactionMessage, {
                            message_thread_id: topicId,
                            parse_mode: 'Markdown',
                            disable_notification: true 
                        });
                        logger.info(`✨ Reaction forwarded to Telegram: ${reactionMessage} in topic ${topicId}`);
                    } catch (error) {
                        logger.error(`❌ Failed to forward WhatsApp reaction to Telegram for ${remoteJid}:`, error.message || error);
                    }
                }
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut; // Use DisconnectReason
                logger.error('❌ WhatsApp connection closed!', { shouldReconnect });
                if (shouldReconnect) {
                    logger.info('🔄 Attempting to reconnect WhatsApp...');
                } else {
                    logger.info('🛑 WhatsApp connection stopped (Auth error).');
                }
            } else if (connection === 'open') {
                logger.info('✅ WhatsApp connection opened.');
                this.syncContacts();
            }
        });

        sock.ev.on('presence.update', async (update) => {
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) return;

            const { id, presences } = update; 
            const whatsappJid = id;

            const topicId = this.chatMappings.get(whatsappJid);
            if (!topicId) return; 

            const presence = Object.values(presences)[0]; 

            if (presence) {
                clearTimeout(this.presenceTimeout); 
                let statusMessage = '';
                switch (presence.lastKnownPresence) {
                    case 'available':
                        statusMessage = `🟢 ${await this.getContactDisplayName(whatsappJid)} is online.`;
                        break;
                    case 'composing':
                        statusMessage = `✍️ ${await this.getContactDisplayName(whatsappJid)} is typing...`;
                        break;
                    case 'recording':
                        statusMessage = `🎙️ ${await this.getContactDisplayName(whatsappJid)} is recording...`;
                        break;
                    case 'unavailable':
                        this.presenceTimeout = setTimeout(async () => {
                            statusMessage = `⚪ ${await this.getContactDisplayName(whatsappJid)} is offline.`;
                            await this.queueTelegramMessage(telegramChatId, statusMessage, {
                                message_thread_id: topicId,
                                disable_notification: true 
                            }).catch(e => logger.debug('Error sending offline status:', e.message));
                            this.statusMessageIds.delete(topicId); 
                        }, 5000); 
                        break;
                }

                if (statusMessage && presence.lastKnownPresence !== 'unavailable') {
                    const oldMessageId = this.statusMessageIds.get(topicId);
                    if (oldMessageId) {
                        try {
                            await this.telegramBot.deleteMessage(telegramChatId, oldMessageId);
                        } catch (e) {
                            logger.debug('Could not delete old status message:', e.message);
                        }
                    }
                    const sentMsg = await this.queueTelegramMessage(telegramChatId, statusMessage, {
                        message_thread_id: topicId,
                        disable_notification: true 
                    });
                    this.statusMessageIds.set(topicId, sentMsg.message_id);
                }
            }
        });

        sock.ev.on('group-participants.update', async (update) => {
            const { id, participants, action } = update; 
            const groupJid = id;
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) return;

            const topicId = this.chatMappings.get(groupJid);
            if (!topicId) return; 

            let notificationMessage = '';
            for (const participantJid of participants) {
                const participantName = await this.getContactDisplayName(participantJid);
                if (action === 'add') {
                    notificationMessage += `➕ ${participantName} joined the group.\n`;
                } else if (action === 'remove') {
                    notificationMessage += `➖ ${participantName} left the group.\n`;
                } else if (action === 'demote') {
                    notificationMessage += `⬇️ ${participantName} was demoted.\n`;
                } else if (action === 'promote') {
                    notificationMessage += `⬆️ ${participantName} was promoted.\n`;
                }
            }

            if (notificationMessage) {
                await this.queueTelegramMessage(telegramChatId, notificationMessage, {
                    message_thread_id: topicId,
                    disable_notification: true
                }).catch(e => logger.debug('Error sending group participant update:', e.message));
            }
        });

        sock.ev.on('call', async (calls) => {
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) return;

            for (const call of calls) {
                const peerJid = call.chatId; 
                const topicId = this.chatMappings.get(peerJid);

                if (!topicId) {
                    logger.debug(`Ignoring call notification for non-bridged JID: ${peerJid}`);
                    continue; 
                }

                const callerName = await this.getContactDisplayName(call.chatId);
                let notificationMessage = '';
                if (call.status === 'offer') {
                    if (!this.activeCallNotifications.has(call.id)) { 
                        notificationMessage = `📞 *Incoming call from ${callerName}* (${peerJid.split('@')[0]})`;
                        const sentMsg = await this.queueTelegramMessage(telegramChatId, notificationMessage, {
                            message_thread_id: topicId,
                            parse_mode: 'Markdown'
                        });
                        this.activeCallNotifications.set(call.id, { messageId: sentMsg.message_id, topicId: topicId });
                    }
                } else if (call.status === 'end') {
                    notificationMessage = `📵 Call with ${callerName} ended.`;
                    const callInfo = this.activeCallNotifications.get(call.id);
                    if (callInfo) {
                        try {
                            await this.telegramBot.editMessageText(notificationMessage, {
                                chat_id: telegramChatId,
                                message_id: callInfo.messageId,
                                message_thread_id: callInfo.topicId,
                                parse_mode: 'Markdown'
                            });
                        } catch (e) {
                            logger.debug('Could not edit old call message:', e.message);
                            await this.queueTelegramMessage(telegramChatId, notificationMessage, {
                                message_thread_id: topicId,
                                parse_mode: 'Markdown'
                            });
                        } finally {
                            this.activeCallNotifications.delete(call.id);
                        }
                    } else {
                         await this.queueTelegramMessage(telegramChatId, notificationMessage, {
                            message_thread_id: topicId,
                            parse_mode: 'Markdown'
                        });
                    }
                }
            }
        });

        logger.info('📱 WhatsApp event handlers set up for Telegram bridge');
    }

    async syncContacts() {
        logger.info('🔄 Initiating WhatsApp contact sync...');
        const sock = this.whatsappBot.sock;
        if (!sock || !sock.user) {
            logger.warn('⚠️ WhatsApp client not connected. Cannot sync contacts.');
            return;
        }

        try {
            // Use sock.contacts from Baileys store (it's automatically populated)
            // If sock.contacts is empty or not yet populated, Baileys needs more time or specific query.
            // For robust sync, a query is safer, but relies on Baileys internal query methods.
            // Using the cached `sock.contacts` is generally efficient after connection is open.
            
            let syncedCount = 0;
            if (sock.contacts) {
                for (const jid in sock.contacts) {
                    const contact = sock.contacts[jid];
                    // Ensure it's a valid individual contact, not groups or broadcast
                    if (jid.endsWith('@s.whatsapp.net')) { 
                        const displayName = contact.name || contact.verifiedName || contact.notify || jid.split('@')[0];
                        const phoneNumber = jid.split('@')[0];
                        await this.saveContactMapping(jid, displayName, phoneNumber); // Save with JID as key
                        syncedCount++;
                    }
                }
            } else {
                logger.warn('⚠️ sock.contacts is not available for sync. WhatsApp store might not be ready.');
            }
            logger.info(`✅ WhatsApp contact sync complete. Synced ${syncedCount} new/updated contacts.`);
        } catch (error) {
            logger.error('❌ Failed to sync WhatsApp contacts:', error.message || error);
        }
    }

    startBridge() {
        if (this.bridgeActive) {
            logger.info('Bridge is already active.');
            return;
        }
        this.bridgeActive = true;
        logger.info('Bridge functionality activated.');
    }

    stopBridge() {
        if (!this.bridgeActive) {
            logger.info('Bridge is already inactive.');
            return;
        }
        this.bridgeActive = false;
        logger.info('Bridge functionality deactivated.');
    }

    getUptime() {
        const uptimeInSeconds = Math.floor((Date.now() - this.startTime) / 1000);
        const hours = Math.floor(uptimeInSeconds / 3600);
        const minutes = Math.floor((uptimeInSeconds % 3600) / 60);
        const seconds = Math.floor(uptimeInSeconds % 60);
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        if (this.presenceTimeout) {
            clearTimeout(this.presenceTimeout);
        }
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error.message || error);
            }
        }
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error.message || error);
        }
        
        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;
