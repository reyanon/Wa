const TelegramBot = require('node-telegram-bot-api');
const TelegramCommands = require('./comands'); // Ensure this path is correct
const config = require('../config');
const logger = require('./logger');
const { connectDb, closeDb } = require('./db'); // Import connectDb and closeDb
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.commands = null;
        // Mappings will now be primarily loaded/saved from/to MongoDB via 'collections'
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // Telegram User ID -> WhatsApp JID (for private chats with bot)
        this.contactMappings = new Map(); // WhatsApp JID -> Contact Name (for display)
        this.profilePicCache = new Map(); // JID -> Base64/Buffer (for Telegram display)
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false; // Flag to prevent concurrent message processing
        this.activeCallNotifications = new Map(); // Store ongoing call notifications
        this.statusMessageIds = new Map(); // For managing status messages
        this.presenceTimeout = null;
        this.botChatId = null; // Telegram chat ID for direct bot interactions (often owner's private chat)
        this.db = null; // MongoDB database instance
        this.collections = {}; // To hold references to MongoDB collections
        this.startTime = Date.now(); // For uptime
        this.bridgeActive = true; // Bridge starts as active by default
    }

    async initialize(dbInstance) {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId'); // Main Telegram Supergroup Chat ID
        
        if (!token || token.includes('YOUR_BOT_TOKEN') || !chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly. Bridging will not start.');
            // Do not throw, allow bot to run without Telegram bridge if not configured
            return;
        }

        try {
            // Use the pre-connected DB instance
            this.db = dbInstance;
            if (!this.db) {
                logger.error('❌ Database instance not provided to TelegramBridge. Exiting initialization.');
                return;
            }

            // Define collections
            this.collections.chatMappings = this.db.collection('chat_mappings');
            this.collections.userMappings = this.db.collection('user_mappings');
            this.collections.contactMappings = this.db.collection('contact_mappings');
            logger.info('📊 MongoDB collections initialized in TelegramBridge.');

            // Load existing mappings from DB
            await this.loadMappingsFromDb();
            logger.info(`Loaded ${this.chatMappings.size} chat mappings, ${this.userMappings.size} user mappings, ${this.contactMappings.size} contact mappings from DB.`);

            this.telegramBot = new TelegramBot(token, { polling: true });
            logger.info('✅ Telegram bot initialized.');

            // Initialize commands
            this.commands = new TelegramCommands(this); // Pass the bridge instance to commands
            logger.info('✅ Telegram commands initialized.');

            this.setupTelegramHandlers();
            this.setupWhatsAppHandlers();

            // Set webhook if specified (optional, only if you're not using long polling)
            const webhookUrl = config.get('telegram.webhookUrl');
            if (webhookUrl) {
                await this.telegramBot.setWebhook(webhookUrl);
                logger.info(`🌍 Telegram webhook set to ${webhookUrl}`);
            }

            // Create temp directory if it doesn't exist
            await fs.ensureDir(this.tempDir);

            // Sync contacts on startup
            await this.syncContacts(); // Initial sync of contacts
            
            logger.info('🚀 Telegram bridge initialized and ready.');

        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
            // Propagate error if critical, or handle gracefully
        }
    }

    async loadMappingsFromDb() {
        try {
            const chatMaps = await this.collections.chatMappings.find({}).toArray();
            this.chatMappings.clear();
            chatMaps.forEach(map => this.chatMappings.set(map.whatsappJid, map.telegramTopicId));

            const userMaps = await this.collections.userMappings.find({}).toArray();
            this.userMappings.clear();
            userMaps.forEach(map => this.userMappings.set(map.telegramUserId, map.whatsappJid));

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
            this.chatMappings.set(whatsappJid, telegramTopicId); // Update in-memory map
            logger.debug(`Saved chat mapping: ${whatsappJid} -> ${telegramTopicId}`);
        } catch (error) {
            logger.error(`❌ Error saving chat mapping for ${whatsappJid}:`, error);
        }
    }

    async saveUserMapping(telegramUserId, whatsappJid) {
        try {
            await this.collections.userMappings.updateOne(
                { telegramUserId: telegramUserId },
                { $set: { telegramUserId: telegramUserId, whatsappJid: whatsappJid, updatedAt: new Date() } },
                { upsert: true }
            );
            this.userMappings.set(telegramUserId, whatsappJid); // Update in-memory map
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
            this.contactMappings.set(whatsappJid, { name: name, number: number }); // Update in-memory map
            logger.debug(`Saved contact mapping: ${whatsappJid} -> ${name} (${number})`);
        } catch (error) {
            logger.error(`❌ Error saving contact mapping for ${whatsappJid}:`, error);
        }
    }

    // --- Core Bridging Logic ---

    // New: Helper to get contact name or format JID
    async getContactDisplayName(jid) {
        const contact = this.contactMappings.get(jid);
        if (contact && contact.name) {
            return contact.name;
        }
        // Try to get from WhatsApp directly if not in cache
        try {
            const waContact = this.whatsappBot.sock.contacts[jid];
            if (waContact) {
                const name = waContact.name || waContact.verifiedName || waContact.notify;
                if (name) {
                    this.saveContactMapping(jid, name, waContact.id.split('@')[0]); // Save for future use
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

        // Determine the display name for the topic
        let displayName = await this.getContactDisplayName(whatsappJid);
        if (!displayName && initialPushName) {
            displayName = initialPushName; // Use provided pushName if no contact name
        }
        if (!displayName) {
            displayName = whatsappJid.split('@')[0]; // Fallback to number if nothing else
        }

        if (!topicId) {
            logger.info(`Creating new topic for ${displayName} (${whatsappJid})...`);
            try {
                // Ensure the main chat ID is a supergroup and supports topics
                const topic = await this.telegramBot.createForumTopic(telegramChatId, displayName);
                topicId = topic.message_thread_id;
                await this.saveChatMapping(whatsappJid, topicId);
                logger.info(`🎉 Created new topic "${displayName}" (ID: ${topicId}) for ${whatsappJid}`);
                
                // Post a welcome message in the new topic
                await this.telegramBot.sendMessage(telegramChatId, 
                    `🔗 New chat linked: *${displayName}* (${whatsappJid})\n\n` +
                    `Messages sent here will go to WhatsApp.`,
                    { message_thread_id: topicId, parse_mode: 'Markdown' }
                );

            } catch (error) {
                logger.error(`❌ Failed to create Telegram topic for ${whatsappJid}:`, error);
                if (error.response && error.response.body && error.response.body.description) {
                    if (error.response.body.description.includes('forum topic support is not enabled')) {
                        logger.error('❗️ Telegram group does not have forum topics enabled. Please enable them in group settings.');
                        await this.telegramBot.sendMessage(this.botChatId || telegramChatId, '❌ Failed to create topic: Forum topic support is not enabled in the main Telegram group. Please enable it in group settings.', { parse_mode: 'Markdown' });
                    } else if (error.response.body.description.includes('FORUM_BOT_NOT_AN_ADMIN')) {
                         logger.error('❗️ Telegram bot is not an admin in the main group, or lacks necessary permissions to manage topics.');
                         await this.telegramBot.sendMessage(this.botChatId || telegramChatId, '❌ Failed to create topic: Telegram bot is not an admin in the main group or lacks necessary permissions (e.g., manage topics).', { parse_mode: 'Markdown' });
                    }
                }
                return null;
            }
        } else {
            // Update topic name if contact name has changed or for group names
            const currentTopicName = await this.getContactDisplayName(whatsappJid);
            if (currentTopicName && currentTopicName !== displayName) { // Only update if name is different
                try {
                    await this.telegramBot.editForumTopic(telegramChatId, topicId, { name: currentTopicName });
                    logger.debug(`📝 Updated topic name for ${whatsappJid} to ${currentTopicName}`);
                } catch (error) {
                    // This can fail if topic is closed, or if name hasn't changed. Log as debug.
                    logger.debug(`Could not update topic name for ${whatsappJid}: ${error.message}`);
                }
            }
        }
        return topicId;
    }

    async handleIncomingWhatsAppMessage(msg) {
        // Only process if bridge is active
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

            const senderJid = m.key.participant || m.key.remoteJid; // For groups, participant is sender. For private, remoteJid is sender.
            const remoteJid = m.key.remoteJid; // The chat where the message originated (group JID or private chat JID)
            const isGroup = remoteJid.endsWith('@g.us');
            
            // Determine the JID for topic creation:
            // If it's a group message, the topic is for the group itself (remoteJid).
            // If it's a private message, the topic is for the person sending the message (senderJid).
            const whatsappJidForTopic = isGroup ? remoteJid : senderJid;

            const senderName = m.pushName || (await this.getContactDisplayName(senderJid)); // Get display name for message content

            // Get or create the Telegram topic for this WhatsApp JID
            const telegramTopicId = await this.getOrCreateTopic(whatsappJidForTopic, { 
                initialPushName: m.pushName, // Pass pushName as a hint for topic creation
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
                // Prepend sender's name unless it's a message from the bot's own number
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

                // Bug Fix: Handle Video Notes (videoMessage with ptt: true and short duration)
                if (message.videoMessage.seconds <= 60 && message.videoMessage.ptt) { // Heuristic for video notes
                    mediaType = 'video_note';
                    messageContent = `🎥 *${senderName}* (Video Note)`;
                }
            } else if (message.audioMessage) {
                mediaType = 'audio';
                fileBuffer = await downloadContentFromMessage(message.audioMessage, 'audio');
                mimeType = message.audioMessage.mimetype;
                fileName = `${m.key.id}.${mime.extension(mimeType)}`;
                messageContent = `🎵 *${senderName}* (Audio)`;
                if (message.audioMessage.ptt) { // Voice message
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
                // Send as a Telegram location message
                try {
                    await this.telegramBot.sendLocation(telegramChatId, degreesLatitude, degreesLongitude, {
                        message_thread_id: telegramTopicId
                    });
                    await this.telegramBot.sendMessage(telegramChatId, messageContent, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                    continue; // Skip general text message part
                } catch (error) {
                    logger.error(`❌ Failed to send location to Telegram:`, error);
                }
            } else if (message.contactMessage) {
                mediaType = 'contact';
                const displayName = message.contactMessage.displayName;
                const vcard = message.contactMessage.vcard;
                messageContent = `👤 *${senderName}* (Contact: ${displayName})`;
                 try {
                    await this.telegramBot.sendContact(telegramChatId, vcard.tel, displayName, {
                        message_thread_id: telegramTopicId
                    });
                     await this.telegramBot.sendMessage(telegramChatId, messageContent, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                    continue; // Skip general text message part
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

                    switch (mediaType) {
                        case 'photo':
                            await this.telegramBot.sendPhoto(telegramChatId, filePath, {
                                caption: `${messageContent}${caption ? '\n' + caption : ''}`,
                                message_thread_id: telegramTopicId,
                                parse_mode: 'Markdown'
                            });
                            break;
                        case 'video':
                            await this.telegramBot.sendVideo(telegramChatId, filePath, {
                                caption: `${messageContent}${caption ? '\n' + caption : ''}`,
                                message_thread_id: telegramTopicId,
                                parse_mode: 'Markdown'
                            });
                            break;
                        case 'video_note': // NEW: Handle video notes
                            // Telegram's sendVideoNote is for short circular videos
                            await this.telegramBot.sendVideoNote(telegramChatId, filePath, {
                                message_thread_id: telegramTopicId
                            });
                            await this.telegramBot.sendMessage(telegramChatId, messageContent, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                            break;
                        case 'audio':
                            await this.telegramBot.sendAudio(telegramChatId, filePath, {
                                caption: messageContent,
                                message_thread_id: telegramTopicId,
                                parse_mode: 'Markdown'
                            });
                            break;
                        case 'voice': // NEW: Handle voice messages
                            await this.telegramBot.sendVoice(telegramChatId, filePath, {
                                caption: messageContent,
                                message_thread_id: telegramTopicId,
                                parse_mode: 'Markdown'
                            });
                            break;
                        case 'document':
                            await this.telegramBot.sendDocument(telegramChatId, filePath, {
                                caption: `${messageContent}${caption ? '\n' + caption : ''}`,
                                fileName: fileName,
                                message_thread_id: telegramTopicId,
                                parse_mode: 'Markdown'
                            });
                            break;
                        case 'sticker':
                            await this.telegramBot.sendSticker(telegramChatId, filePath, {
                                message_thread_id: telegramTopicId
                            });
                            await this.telegramBot.sendMessage(telegramChatId, messageContent, { message_thread_id: telegramTopicId, parse_mode: 'Markdown' });
                            break;
                    }
                    await fs.remove(filePath); // Clean up temp file
                } else if (messageContent) {
                    await this.telegramBot.sendMessage(telegramChatId, messageContent, {
                        message_thread_id: telegramTopicId,
                        parse_mode: 'Markdown'
                    });
                }
            } catch (error) {
                logger.error(`❌ Error forwarding WhatsApp message to Telegram for ${whatsappJidForTopic}:`, error);
                // Attempt to send a fallback text message if media failed
                if (messageContent) {
                    await this.telegramBot.sendMessage(telegramChatId, `⚠️ Error forwarding message from WhatsApp (from ${senderName}): ${error.message}\n\nOriginal content: ${messageContent}`, {
                        message_thread_id: telegramTopicId,
                        parse_mode: 'Markdown'
                    });
                }
            }
        }
    }

    async handleIncomingTelegramMessage(msg) {
        // Only process if bridge is active
        if (!this.bridgeActive) {
            logger.debug('Telegram bridge is inactive, skipping Telegram message.');
            return;
        }

        const telegramChatId = config.get('telegram.chatId');
        // Ignore messages not from the designated bridging chat
        if (msg.chat.id.toString() !== telegramChatId) {
            // Also ignore commands from other chats if not the bot's direct chat
            if (!msg.text || !msg.text.startsWith('/')) { // Ignore non-command messages from outside the main chat
                logger.debug(`Ignoring message from non-target chat: ${msg.chat.id}`);
                return;
            }
        }

        const telegramTopicId = msg.message_thread_id; // For forum topics
        const isReply = msg.reply_to_message;

        let targetWhatsappJid = null;
        if (telegramTopicId) {
            // Find WhatsApp JID from chatMappings based on Telegram Topic ID
            targetWhatsappJid = Array.from(this.chatMappings.entries())
                                    .find(([jid, topicId]) => topicId === telegramTopicId)?.[0];
        } else if (msg.chat.type === 'private' && this.isOwner(msg.from.id)) { // Allow owner to send direct messages to bot's linked WhatsApp
             targetWhatsappJid = this.userMappings.get(msg.from.id);
             if (!targetWhatsappJid) {
                targetWhatsappJid = config.get('whatsapp.ownerJid'); // Fallback to configured ownerJid
             }
        }

        if (!targetWhatsappJid) {
            logger.warn(`⚠️ Could not determine target WhatsApp JID for Telegram message from chat ${msg.chat.id}, topic ${telegramTopicId}.`);
            if (msg.chat.type !== 'private' && telegramTopicId) { // Only send warning to topic if it's a topic
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not find a linked WhatsApp chat for this topic.', { message_thread_id: telegramTopicId });
            } else if (msg.chat.type === 'private' && this.commands.isOwner(msg.from.id)) { // Warn owner in private chat
                 await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not find a linked WhatsApp chat for this message. Use /send <number> <message> to initiate or respond in a bridged topic.', { parse_mode: 'Markdown' });
            }
            return;
        }

        let messageContent = '';
        let mediaType = null;
        let fileUrl = null;
        let fileName = '';
        let mimeType = '';
        let caption = '';

        if (msg.text) {
            // If it's a reply to a message from the bot within a topic, forward it to WhatsApp
            if (telegramTopicId && isReply) {
                 messageContent = msg.text;
            } else if (msg.chat.type === 'private' && this.commands.isOwner(msg.from.id)) { // Allow direct private messages from owner
                messageContent = msg.text;
            } else {
                // Ignore non-reply text messages in a bridged topic/group to prevent endless loops or unwanted forwards
                logger.debug(`Ignoring non-reply text message in bridged group/topic from ${msg.from.id}: ${msg.text}`);
                return; 
            }
        } else if (msg.photo && msg.photo.length > 0) {
            mediaType = 'image';
            const photo = msg.photo[msg.photo.length - 1]; // Get the highest resolution photo
            fileUrl = await this.telegramBot.getFileLink(photo.file_id);
            caption = msg.caption || '';
            // WhatsApp often prefers JPEG for photos
            mimeType = 'image/jpeg'; 
            fileName = `telegram_photo_${msg.message_id}.jpeg`;
        } else if (msg.video) {
            mediaType = 'video';
            fileUrl = await this.telegramBot.getFileLink(msg.video.file_id);
            caption = msg.caption || '';
            mimeType = msg.video.mime_type;
            fileName = `telegram_video_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.audio) {
            mediaType = 'audio';
            fileUrl = await this.telegramBot.getFileLink(msg.audio.file_id);
            caption = msg.caption || '';
            mimeType = msg.audio.mime_type;
            fileName = `telegram_audio_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.voice) { // Telegram Voice message
            mediaType = 'voice';
            fileUrl = await this.telegramBot.getFileLink(msg.voice.file_id);
            mimeType = msg.voice.mime_type; // Should be 'audio/ogg'
            fileName = `telegram_voice_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.document) {
            mediaType = 'document';
            fileUrl = await this.telegramBot.getFileLink(msg.document.file_id);
            caption = msg.caption || '';
            mimeType = msg.document.mime_type;
            fileName = msg.document.file_name || `telegram_document_${msg.message_id}.${mime.extension(mimeType)}`;
        } else if (msg.sticker) { // NEW: Handle Stickers from Telegram to WhatsApp
            mediaType = 'sticker';
            fileUrl = await this.telegramBot.getFileLink(msg.sticker.file_id);
            mimeType = msg.sticker.mime_type; // Typically 'image/webp' for static, 'application/x-tgsticker' for animated
            fileName = `telegram_sticker_${msg.message_id}.${mime.extension(mimeType) || 'webp'}`; // Default to webp if unknown
        } else if (msg.location) {
            // Forward Telegram location to WhatsApp
            try {
                await this.whatsappBot.sendMessage(targetWhatsappJid, {
                    location: { degreesLatitude: msg.location.latitude, degreesLongitude: msg.location.longitude }
                });
                logger.info(`📍 Forwarded Telegram location to ${targetWhatsappJid}`);
            } catch (error) {
                logger.error(`❌ Failed to forward Telegram location:`, error);
            }
            return; // Exit as location is handled
        } else if (msg.contact) {
            // Forward Telegram contact to WhatsApp
            try {
                const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${msg.contact.first_name} ${msg.contact.last_name || ''}\nTEL;TYPE=CELL:${msg.contact.phone_number}\nEND:VCARD`;
                await this.whatsappBot.sendMessage(targetWhatsappJid, {
                    contacts: {
                        displayName: `${msg.contact.first_name} ${msg.contact.last_name || ''}`,
                        contacts: [{ vcard }]
                    }
                });
                logger.info(`👤 Forwarded Telegram contact to ${targetWhatsappJid}`);
            } catch (error) {
                logger.error(`❌ Failed to forward Telegram contact:`, error);
            }
            return; // Exit as contact is handled
        } else if (msg.video_note) { // Telegram video note
            mediaType = 'video_note';
            fileUrl = await this.telegramBot.getFileLink(msg.video_note.file_id);
            mimeType = msg.video_note.mime_type; // 'video/mp4' or 'video/quicktime'
            fileName = `telegram_videonote_${msg.message_id}.${mime.extension(mimeType) || 'mp4'}`;
            // WhatsApp doesn't have a direct "video note" type to send, typically sent as a regular video
            // Or if it's very short, Baileys might handle it as a voice message (ptt=true for audio)
            // For now, treat as a short video.
        } else {
            logger.warn('⚠️ Unhandled Telegram message type:', msg);
            return; // Do not forward unhandled types
        }

        if (messageContent) {
            try {
                await this.whatsappBot.sendMessage(targetWhatsappJid, { text: messageContent });
                logger.info(`💬 Forwarded Telegram text to ${targetWhatsappJid}`);
            } catch (error) {
                logger.error(`❌ Failed to forward Telegram text to ${targetWhatsappJid}:`, error);
            }
        } else if (fileUrl && mediaType) {
            try {
                const response = await axios({
                    method: 'get',
                    url: fileUrl,
                    responseType: 'arraybuffer'
                });
                const fileBuffer = Buffer.from(response.data);
                const filePath = path.join(this.tempDir, fileName);

                // Handle image resizing for WhatsApp if it's a photo
                if (mediaType === 'photo' && mimeType === 'image/jpeg') {
                    // Resize/compress image to ensure compatibility with WhatsApp
                    const processedBuffer = await sharp(fileBuffer)
                        .jpeg({ quality: 80 }) // Adjust quality as needed
                        .toBuffer();
                    await fs.outputFile(filePath, processedBuffer);
                } else if (mediaType === 'sticker') { // Process sticker for WhatsApp
                    // Animated Telegram stickers (.tgs) need to be converted to .webp for WhatsApp
                    // Baileys typically handles this if you give it the correct webp buffer.
                    // If the Telegram sticker is already webp, just save it.
                    // If it's .tgs, you'd need a library like 'lottie-web' + 'sharp' for conversion,
                    // but for simplicity, directly saving and letting Baileys handle it is best.
                    await fs.outputFile(filePath, fileBuffer);
                } else {
                    await fs.outputFile(filePath, fileBuffer);
                }
                
                const messageOptions = { caption: caption || undefined };

                switch (mediaType) {
                    case 'image':
                    case 'photo':
                        await this.whatsappBot.sendMessage(targetWhatsappJid, { image: { url: filePath }, ...messageOptions });
                        break;
                    case 'video':
                    case 'video_note': // Treat video notes as regular videos for sending
                        await this.whatsappBot.sendMessage(targetWhatsappJid, { video: { url: filePath }, ...messageOptions });
                        break;
                    case 'audio':
                        await this.whatsappBot.sendMessage(targetWhatsappJid, { audio: { url: filePath }, mimetype: mimeType, ...messageOptions });
                        break;
                    case 'voice':
                        await this.whatsappBot.sendMessage(targetWhatsappJid, { audio: { url: filePath }, mimetype: 'audio/ogg; codecs=opus', ptt: true, ...messageOptions });
                        break;
                    case 'document':
                        await this.whatsappBot.sendMessage(targetWhatsappJid, { document: { url: filePath }, fileName: fileName, mimetype: mimeType, ...messageOptions });
                        break;
                    case 'sticker': // NEW: Send as sticker
                        await this.whatsappBot.sendMessage(targetWhatsappJid, { sticker: { url: filePath } });
                        break;
                }
                logger.info(`📤 Forwarded Telegram ${mediaType} to ${targetWhatsappJid}`);
                await fs.remove(filePath); // Clean up temp file
            } catch (error) {
                logger.error(`❌ Error forwarding Telegram ${mediaType} to ${targetWhatsappJid}:`, error);
                await this.telegramBot.sendMessage(msg.chat.id, `❌ Failed to send ${mediaType} to WhatsApp: ${error.message}`, { message_thread_id: telegramTopicId });
            }
        }
    }

    setupTelegramHandlers() {
        // Handle all non-command messages from the target chat or private chat
        this.telegramBot.on('message', async (msg) => {
            // Ignore messages from the bot itself to prevent loops
            if (msg.from.id === this.telegramBot.options.id) {
                return;
            }
            // Commands are handled by TelegramCommands, so skip messages starting with '/'
            if (msg.text && msg.text.startsWith('/')) {
                return;
            }
            await this.handleIncomingTelegramMessage(msg);
        });

        // Error handling for Telegram Bot
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

        // Message Listener (for new messages)
        sock.ev.on('messages.upsert', async (m) => {
            // Process messages not sent by 'fromMe'
            // If m.key.fromMe is true, it's a message sent by the bot's own WhatsApp number.
            // We should process it if it's a group message where the bot is a participant
            // or if it's a message from the bot's own number to a new contact (initial message)
            // that needs a topic created.
            // However, typical bridging focuses on messages *from others*.
            // For now, the existing check `if (m.messages[0].key.fromMe)` handles common cases
            // where bot-sent messages shouldn't trigger topic creation loops.
            // Further refinement would be needed if the bot needs to bridge its own outgoing messages.
            if (m.messages[0].key.fromMe && !m.messages[0].key.remoteJid.endsWith('@g.us')) { // Ignore own private messages
                logger.debug('Ignoring message from self (WhatsApp private chat):', m.messages[0].key.id);
                return;
            }
            // For general incoming messages, and for group messages from self, process them
            await this.handleIncomingWhatsAppMessage(m);
        });

        // NEW: Message Update Listener (for reactions)
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
                    const reaction = update.update.reactions[0]; // Get the latest reaction
                    const remoteJid = reaction.key.remoteJid; // The chat where the reaction happened
                    const reactorJid = reaction.key.participant || remoteJid; // Reactor's JID

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
                        await this.telegramBot.sendMessage(telegramChatId, reactionMessage, {
                            message_thread_id: topicId,
                            parse_mode: 'Markdown',
                            disable_notification: true // Send silently
                        });
                        logger.info(`✨ Reaction forwarded to Telegram: ${reactionMessage} in topic ${topicId}`);
                    } catch (error) {
                        logger.error(`❌ Failed to forward WhatsApp reaction to Telegram for ${remoteJid}:`, error);
                    }
                }
            }
        });

        // WhatsApp connection status updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                logger.error('❌ WhatsApp connection closed!', { shouldReconnect });
                if (shouldReconnect) {
                    logger.info('🔄 Attempting to reconnect WhatsApp...');
                    // This should be handled by the main bot (AdvancedWhatsAppBot)
                } else {
                    logger.info('🛑 WhatsApp connection stopped (Auth error).');
                }
            } else if (connection === 'open') {
                logger.info('✅ WhatsApp connection opened.');
                // Trigger a sync after successful connection
                this.syncContacts();
            }
        });

        // Presence updates (online/typing/recording)
        sock.ev.on('presence.update', async (update) => {
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) return;

            const { id, presences } = update; // id is remoteJid
            const whatsappJid = id;

            const topicId = this.chatMappings.get(whatsappJid);
            if (!topicId) return; // Only notify for bridged chats

            const presence = Object.values(presences)[0]; // Get the first presence for the JID

            if (presence) {
                clearTimeout(this.presenceTimeout); // Clear previous timeout
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
                        // Do not send unavailable immediately, wait a bit
                        this.presenceTimeout = setTimeout(async () => {
                            statusMessage = `⚪ ${await this.getContactDisplayName(whatsappJid)} is offline.`;
                            await this.telegramBot.sendMessage(telegramChatId, statusMessage, {
                                message_thread_id: topicId,
                                disable_notification: true // Send silently
                            }).catch(e => logger.debug('Error sending offline status:', e.message));
                            this.statusMessageIds.delete(topicId); // Clear status message ID
                        }, 5000); // 5 seconds delay for offline status
                        break;
                }

                if (statusMessage && presence.lastKnownPresence !== 'unavailable') {
                    // Delete previous status message if exists
                    const oldMessageId = this.statusMessageIds.get(topicId);
                    if (oldMessageId) {
                        try {
                            await this.telegramBot.deleteMessage(telegramChatId, oldMessageId);
                        } catch (e) {
                            logger.debug('Could not delete old status message:', e.message);
                        }
                    }
                    // Send new status message
                    const sentMsg = await this.telegramBot.sendMessage(telegramChatId, statusMessage, {
                        message_thread_id: topicId,
                        disable_notification: true // Send silently
                    });
                    this.statusMessageIds.set(topicId, sentMsg.message_id);
                }
            }
        });

        // Handle new participants in groups (for group-level updates, if applicable)
        sock.ev.on('group-participants.update', async (update) => {
            const { id, participants, action } = update; // id is group JID
            const groupJid = id;
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) return;

            const topicId = this.chatMappings.get(groupJid);
            if (!topicId) return; // Only notify for bridged groups

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
                await this.telegramBot.sendMessage(telegramChatId, notificationMessage, {
                    message_thread_id: topicId,
                    disable_notification: true
                }).catch(e => logger.debug('Error sending group participant update:', e.message));
            }
        });

        // Handling calls
        sock.ev.on('call', async (calls) => {
            const telegramChatId = config.get('telegram.chatId');
            if (!telegramChatId) return;

            for (const call of calls) {
                const peerJid = call.chatId; // The JID of the other party in the call
                const topicId = this.chatMappings.get(peerJid);

                if (!topicId) {
                    logger.debug(`Ignoring call notification for non-bridged JID: ${peerJid}`);
                    continue; // Only notify for bridged chats
                }

                const callerName = await this.getContactDisplayName(call.chatId);
                let notificationMessage = '';
                if (call.status === 'offer') {
                    // New incoming call
                    if (!this.activeCallNotifications.has(call.id)) { // Prevent duplicate notifications
                        notificationMessage = `📞 *Incoming call from ${callerName}* (${peerJid.split('@')[0]})`;
                        const sentMsg = await this.telegramBot.sendMessage(telegramChatId, notificationMessage, {
                            message_thread_id: topicId,
                            parse_mode: 'Markdown'
                        });
                        this.activeCallNotifications.set(call.id, { messageId: sentMsg.message_id, topicId: topicId });
                    }
                } else if (call.status === 'end') {
                    // Call ended
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
                            await this.telegramBot.sendMessage(telegramChatId, notificationMessage, {
                                message_thread_id: topicId,
                                parse_mode: 'Markdown'
                            });
                        } finally {
                            this.activeCallNotifications.delete(call.id);
                        }
                    } else {
                         await this.telegramBot.sendMessage(telegramChatId, notificationMessage, {
                            message_thread_id: topicId,
                            parse_mode: 'Markdown'
                        });
                    }
                }
                // Add more call statuses if needed (e.g., "accept", "reject")
            }
        });


        logger.info('📱 WhatsApp event handlers set up for Telegram bridge');
    }

    // --- Contact Sync ---
    async syncContacts() {
        logger.info('🔄 Initiating WhatsApp contact sync...');
        const sock = this.whatsappBot.sock;
        if (!sock || !sock.user) {
            logger.warn('⚠️ WhatsApp client not connected. Cannot sync contacts.');
            return;
        }

        try {
            // Force fetch contacts to ensure up-to-date list
            const contacts = await sock.query({
                tag: 'iq',
                type: 'get',
                query: ['query', 'contact'],
                id: sock.generateMessageTag(),
            });

            // Process the contacts result (this might vary based on Baileys version)
            // For typical Baileys usage, sock.contacts should be sufficient after connection
            // Let's iterate through the store's contacts
            let syncedCount = 0;
            if (sock.contacts) {
                for (const jid in sock.contacts) {
                    const contact = sock.contacts[jid];
                    if (contact.id && contact.id.endsWith('@s.whatsapp.net')) { // Only process individual contacts
                        const displayName = contact.name || contact.verifiedName || contact.notify || contact.id.split('@')[0];
                        const phoneNumber = contact.id.split('@')[0];
                        await this.saveContactMapping(contact.id, displayName, phoneNumber);
                        syncedCount++;
                    }
                }
            } else {
                logger.warn('⚠️ sock.contacts is not available for sync. Ensure WhatsApp is fully connected.');
            }
            logger.info(`✅ WhatsApp contact sync complete. Synced ${syncedCount} contacts.`);
        } catch (error) {
            logger.error('❌ Failed to sync WhatsApp contacts:', error);
        }
    }


    // --- Bridge Control ---
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


    // --- Shutdown ---
    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        if (this.presenceTimeout) {
            clearTimeout(this.presenceTimeout);
        }
        
        if (this.telegramBot) {
            try {
                // Ensure polling is stopped before closing DB connection
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }

        // Close DB connection - This is now handled by AdvancedWhatsAppBot's shutdown
        // await closeDb(); // REMOVED: Handled by main bot's shutdown
        
        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;
