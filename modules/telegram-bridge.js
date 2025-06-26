const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const { Database } = require('../core/database');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');

class TelegramBridge {
    constructor(whatsappBot) {
        this.name = 'Telegram Bridge';
        this.version = '2.0.0';
        this.description = 'Advanced WhatsApp-Telegram Bridge with full control panel';
        
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.database = new Database();
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.systemTopics = {
            status: null,
            calls: null,
            logs: null
        };
        this.bridgeEnabled = true;
        this.settings = {
            allowMedia: true,
            allowStickers: true,
            allowVoice: true,
            allowAudio: true,
            allowDocuments: true,
            allowVideos: true,
            syncContacts: true,
            syncStatus: true,
            syncCalls: true,
            autoUpdateProfilePics: true
        };

        // Commands for WhatsApp bot
        this.commands = [
            {
                name: 'tgbridge',
                description: 'Toggle Telegram bridge on/off',
                category: 'admin',
                execute: this.handleBridgeCommand.bind(this)
            },
            {
                name: 'tgstatus',
                description: 'Check Telegram bridge status',
                category: 'admin',
                execute: this.handleStatusCommand.bind(this)
            }
        ];
    }

    async init() {
        try {
            await this.database.connect();
            await this.initialize();
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
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
            await this.loadMappingsFromDatabase();
            await this.createSystemTopics();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle commands
        this.telegramBot.onText(/\/start/, this.handleStart.bind(this));
        this.telegramBot.onText(/\/bridge (.+)/, this.handleBridgeToggle.bind(this));
        this.telegramBot.onText(/\/settings/, this.handleSettings.bind(this));
        this.telegramBot.onText(/\/contacts/, this.handleContacts.bind(this));
        this.telegramBot.onText(/\/send (.+)/, this.handleSendMessage.bind(this));
        this.telegramBot.onText(/\/sync/, this.handleSync.bind(this));
        this.telegramBot.onText(/\/status/, this.handleBridgeStatus.bind(this));
        this.telegramBot.onText(/\/help/, this.handleHelp.bind(this));
        this.telegramBot.onText(/\/viewonce/, this.handleViewOnce.bind(this));

        // Handle regular messages
        this.telegramBot.on('message', async (msg) => {
            try {
                if (msg.chat.type === 'supergroup' && msg.is_topic_message && !msg.text?.startsWith('/')) {
                    await this.handleTelegramMessage(msg);
                }
            } catch (error) {
                logger.error('❌ Error handling Telegram message:', error);
            }
        });

        // Handle callback queries
        this.telegramBot.on('callback_query', this.handleCallback.bind(this));

        // Handle voice messages
        this.telegramBot.on('voice', this.handleVoiceMessage.bind(this));

        // Handle video notes
        this.telegramBot.on('video_note', this.handleVideoNote.bind(this));

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    async loadMappingsFromDatabase() {
        try {
            const mappings = await this.database.getAllTopicMappings();
            for (const mapping of mappings) {
                this.chatMappings.set(mapping.whatsappJid, mapping.telegramTopicId);
            }
            logger.info(`📊 Loaded ${mappings.length} topic mappings from database`);
        } catch (error) {
            logger.error('❌ Error loading mappings from database:', error);
        }
    }

    async createSystemTopics() {
        const chatId = config.get('telegram.chatId');
        if (!chatId || chatId.includes('2345678901')) {
            logger.error('❌ Telegram chat ID not configured properly');
            return;
        }

        try {
            // Create Status Updates topic
            const statusTopic = await this.telegramBot.createForumTopic(chatId, '📱 Status Updates', {
                icon_color: 0x9367DA
            });
            this.systemTopics.status = statusTopic.message_thread_id;

            // Create Calls & Notifications topic
            const callsTopic = await this.telegramBot.createForumTopic(chatId, '📞 Calls & Notifications', {
                icon_color: 0xFF6B6B
            });
            this.systemTopics.calls = callsTopic.message_thread_id;

            logger.info('✅ System topics created');
        } catch (error) {
            logger.error('❌ Failed to create system topics:', error);
        }
    }

    // Telegram Command Handlers
    async handleStart(msg) {
        const welcomeMessage = `🤖 *WhatsApp-Telegram Bridge Control Panel*\n\n` +
                              `🔗 Bridge Status: ${this.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                              `📱 Connected Chats: ${this.chatMappings.size}\n` +
                              `📊 Database: ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                              `*Available Commands:*\n` +
                              `• /bridge on|off - Toggle bridge\n` +
                              `• /settings - Bridge settings\n` +
                              `• /contacts - Manage contacts\n` +
                              `• /send <number> <message> - Send message\n` +
                              `• /sync - Sync contacts\n` +
                              `• /status - Bridge status\n` +
                              `• /help - Show help\n\n` +
                              `🚀 Ready to bridge your messages!`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: this.bridgeEnabled ? '🔴 Turn Off' : '🟢 Turn On', callback_data: 'toggle_bridge' },
                    { text: '⚙️ Settings', callback_data: 'show_settings' }
                ],
                [
                    { text: '👥 Contacts', callback_data: 'show_contacts' },
                    { text: '📊 Status', callback_data: 'show_status' }
                ],
                [
                    { text: '🔄 Sync Now', callback_data: 'sync_contacts' },
                    { text: '❓ Help', callback_data: 'show_help' }
                ]
            ]
        };

        await this.telegramBot.sendMessage(msg.chat.id, welcomeMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleBridgeToggle(msg, match) {
        const action = match[1].toLowerCase();
        
        if (action === 'on') {
            this.bridgeEnabled = true;
            await this.database.setSetting('bridge_enabled', true);
            await this.telegramBot.sendMessage(msg.chat.id, '✅ Bridge enabled successfully!');
        } else if (action === 'off') {
            this.bridgeEnabled = false;
            await this.database.setSetting('bridge_enabled', false);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Bridge disabled successfully!');
        } else {
            await this.telegramBot.sendMessage(msg.chat.id, '❓ Usage: /bridge on|off');
        }
    }

    async handleSettings(msg) {
        const settingsMessage = `⚙️ *Bridge Settings*\n\n` +
                               `📷 Media: ${this.settings.allowMedia ? '✅' : '❌'}\n` +
                               `🎭 Stickers: ${this.settings.allowStickers ? '✅' : '❌'}\n` +
                               `🎵 Voice: ${this.settings.allowVoice ? '✅' : '❌'}\n` +
                               `🔊 Audio: ${this.settings.allowAudio ? '✅' : '❌'}\n` +
                               `📄 Documents: ${this.settings.allowDocuments ? '✅' : '❌'}\n` +
                               `🎥 Videos: ${this.settings.allowVideos ? '✅' : '❌'}\n` +
                               `👥 Sync Contacts: ${this.settings.syncContacts ? '✅' : '❌'}\n` +
                               `📱 Sync Status: ${this.settings.syncStatus ? '✅' : '❌'}\n` +
                               `📞 Sync Calls: ${this.settings.syncCalls ? '✅' : '❌'}\n` +
                               `🖼️ Auto Update Profile Pics: ${this.settings.autoUpdateProfilePics ? '✅' : '❌'}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `📷 Media ${this.settings.allowMedia ? '✅' : '❌'}`, callback_data: 'toggle_media' },
                    { text: `🎭 Stickers ${this.settings.allowStickers ? '✅' : '❌'}`, callback_data: 'toggle_stickers' }
                ],
                [
                    { text: `🎵 Voice ${this.settings.allowVoice ? '✅' : '❌'}`, callback_data: 'toggle_voice' },
                    { text: `🔊 Audio ${this.settings.allowAudio ? '✅' : '❌'}`, callback_data: 'toggle_audio' }
                ],
                [
                    { text: `📄 Docs ${this.settings.allowDocuments ? '✅' : '❌'}`, callback_data: 'toggle_documents' },
                    { text: `🎥 Videos ${this.settings.allowVideos ? '✅' : '❌'}`, callback_data: 'toggle_videos' }
                ],
                [
                    { text: `👥 Contacts ${this.settings.syncContacts ? '✅' : '❌'}`, callback_data: 'toggle_contacts' },
                    { text: `📱 Status ${this.settings.syncStatus ? '✅' : '❌'}`, callback_data: 'toggle_status' }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
                ]
            ]
        };

        await this.telegramBot.sendMessage(msg.chat.id, settingsMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleContacts(msg) {
        try {
            const contacts = await this.database.getAllContacts();
            let contactsMessage = `👥 *Contact List* (${contacts.length} contacts)\n\n`;

            if (contacts.length === 0) {
                contactsMessage += '📭 No contacts found. Send some messages to populate the list.';
            } else {
                contacts.slice(0, 20).forEach((contact, index) => {
                    const emoji = contact.isGroup ? '👥' : '👤';
                    const name = contact.name || contact.phone;
                    const lastSeen = new Date(contact.lastSeen).toLocaleDateString();
                    contactsMessage += `${emoji} *${name}*\n📱 ${contact.phone}\n💬 ${contact.messageCount} messages\n👀 Last seen: ${lastSeen}\n\n`;
                });

                if (contacts.length > 20) {
                    contactsMessage += `... and ${contacts.length - 20} more contacts`;
                }
            }

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔄 Sync Contacts', callback_data: 'sync_contacts' },
                        { text: '🔍 Search Contact', callback_data: 'search_contact' }
                    ],
                    [
                        { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
                    ]
                ]
            };

            await this.telegramBot.sendMessage(msg.chat.id, contactsMessage, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } catch (error) {
            logger.error('❌ Error handling contacts:', error);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Error loading contacts');
        }
    }

    async handleSendMessage(msg, match) {
        const parts = match[1].split(' ');
        const number = parts[0];
        const message = parts.slice(1).join(' ');

        if (!number || !message) {
            await this.telegramBot.sendMessage(msg.chat.id, '❓ Usage: /send <number> <message>');
            return;
        }

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.whatsappBot.sendMessage(jid, { text: message });
            await this.telegramBot.sendMessage(msg.chat.id, `✅ Message sent to ${number}`);
        } catch (error) {
            logger.error('❌ Error sending message:', error);
            await this.telegramBot.sendMessage(msg.chat.id, `❌ Failed to send message: ${error.message}`);
        }
    }

    async handleSync(msg) {
        await this.telegramBot.sendMessage(msg.chat.id, '🔄 Syncing contacts and updating topics...');
        
        try {
            await this.syncAllContacts();
            await this.telegramBot.sendMessage(msg.chat.id, '✅ Sync completed successfully!');
        } catch (error) {
            logger.error('❌ Error syncing:', error);
            await this.telegramBot.sendMessage(msg.chat.id, `❌ Sync failed: ${error.message}`);
        }
    }

    async handleBridgeStatus(msg) {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        const statusMessage = `📊 *Bridge Status Report*\n\n` +
                             `🔗 Bridge: ${this.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                             `📱 WhatsApp: ${this.whatsappBot.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `🤖 Telegram: ${this.telegramBot ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `📊 Database: ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `💬 Active Chats: ${this.chatMappings.size}\n` +
                             `👥 Cached Users: ${this.userMappings.size}\n` +
                             `⏱️ Uptime: ${hours}h ${minutes}m\n` +
                             `🔄 Last Sync: ${new Date().toLocaleString()}`;

        await this.telegramBot.sendMessage(msg.chat.id, statusMessage, {
            parse_mode: 'Markdown'
        });
    }

    async handleHelp(msg) {
        const helpMessage = `❓ *Help & Commands*\n\n` +
                           `*Bridge Control:*\n` +
                           `/start - Show main menu\n` +
                           `/bridge on|off - Toggle bridge\n` +
                           `/status - Show bridge status\n\n` +
                           `*Settings:*\n` +
                           `/settings - Configure bridge settings\n` +
                           `/sync - Sync contacts and topics\n\n` +
                           `*Messaging:*\n` +
                           `/send <number> <message> - Send message to WhatsApp\n` +
                           `/viewonce - Send view-once message\n\n` +
                           `*Management:*\n` +
                           `/contacts - View contact list\n` +
                           `/help - Show this help\n\n` +
                           `*Features:*\n` +
                           `• 📱 Real-time message bridging\n` +
                           `• 🖼️ Media forwarding (images, videos, audio)\n` +
                           `• 🎵 Voice message conversion\n` +
                           `• 📄 Document sharing\n` +
                           `• 👥 Contact synchronization\n` +
                           `• 📱 Status updates forwarding\n` +
                           `• 📞 Call notifications\n` +
                           `• 🔒 View-once message support`;

        await this.telegramBot.sendMessage(msg.chat.id, helpMessage, {
            parse_mode: 'Markdown'
        });
    }

    async handleViewOnce(msg) {
        if (!msg.reply_to_message) {
            await this.telegramBot.sendMessage(msg.chat.id, '❓ Reply to a message to send as view-once');
            return;
        }

        // Implementation for view-once messages
        await this.telegramBot.sendMessage(msg.chat.id, '🔒 View-once message feature coming soon!');
    }

    // Callback handlers
    async handleCallback(query) {
        const data = query.data;
        
        try {
            switch (data) {
                case 'toggle_bridge':
                    this.bridgeEnabled = !this.bridgeEnabled;
                    await this.database.setSetting('bridge_enabled', this.bridgeEnabled);
                    await this.telegramBot.answerCallbackQuery(query.id, {
                        text: `Bridge ${this.bridgeEnabled ? 'enabled' : 'disabled'}!`,
                        show_alert: false
                    });
                    await this.handleStart(query.message);
                    break;

                case 'show_settings':
                    await this.handleSettings(query.message);
                    break;

                case 'show_contacts':
                    await this.handleContacts(query.message);
                    break;

                case 'show_status':
                    await this.handleBridgeStatus(query.message);
                    break;

                case 'sync_contacts':
                    await this.handleSync(query.message);
                    break;

                case 'show_help':
                    await this.handleHelp(query.message);
                    break;

                case 'back_to_menu':
                    await this.handleStart(query.message);
                    break;

                default:
                    if (data.startsWith('toggle_')) {
                        await this.handleSettingToggle(query, data);
                    }
                    break;
            }
        } catch (error) {
            logger.error('❌ Error handling callback:', error);
        }
    }

    async handleSettingToggle(query, data) {
        const setting = data.replace('toggle_', '');
        const settingMap = {
            'media': 'allowMedia',
            'stickers': 'allowStickers',
            'voice': 'allowVoice',
            'audio': 'allowAudio',
            'documents': 'allowDocuments',
            'videos': 'allowVideos',
            'contacts': 'syncContacts',
            'status': 'syncStatus'
        };

        const settingKey = settingMap[setting];
        if (settingKey) {
            this.settings[settingKey] = !this.settings[settingKey];
            await this.database.setSetting(setting, this.settings[settingKey]);
            
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: `${setting} ${this.settings[settingKey] ? 'enabled' : 'disabled'}!`,
                show_alert: false
            });
            
            await this.handleSettings(query.message);
        }
    }

    // WhatsApp Command Handlers
    async handleBridgeCommand(msg, params, context) {
        if (!context.participant.includes(config.get('bot.owner'))) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Only the bot owner can control the Telegram bridge.'
            });
        }

        const action = params[0]?.toLowerCase();
        
        if (action === 'on') {
            this.bridgeEnabled = true;
            await this.database.setSetting('bridge_enabled', true);
            await context.bot.sendMessage(context.sender, {
                text: '✅ Telegram bridge enabled!'
            });
        } else if (action === 'off') {
            this.bridgeEnabled = false;
            await this.database.setSetting('bridge_enabled', false);
            await context.bot.sendMessage(context.sender, {
                text: '❌ Telegram bridge disabled!'
            });
        } else {
            await context.bot.sendMessage(context.sender, {
                text: `🔗 *Telegram Bridge Status*\n\n` +
                      `Status: ${this.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                      `Connected Chats: ${this.chatMappings.size}\n` +
                      `Database: ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                      `Use: ${config.get('bot.prefix')}tgbridge on/off`
            });
        }
    }

    async handleStatusCommand(msg, params, context) {
        const statusMessage = `📊 *Telegram Bridge Status*\n\n` +
                             `🔗 Bridge: ${this.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                             `🤖 Telegram Bot: ${this.telegramBot ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `📊 Database: ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `💬 Active Chats: ${this.chatMappings.size}\n` +
                             `👥 Cached Users: ${this.userMappings.size}\n` +
                             `📱 System Topics: ${Object.values(this.systemTopics).filter(t => t).length}/3\n\n` +
                             `*Settings:*\n` +
                             `📷 Media: ${this.settings.allowMedia ? '✅' : '❌'}\n` +
                             `🎭 Stickers: ${this.settings.allowStickers ? '✅' : '❌'}\n` +
                             `🎵 Voice: ${this.settings.allowVoice ? '✅' : '❌'}\n` +
                             `👥 Sync Contacts: ${this.settings.syncContacts ? '✅' : '❌'}`;

        await context.bot.sendMessage(context.sender, { text: statusMessage });
    }

    // Message processing methods
    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !this.bridgeEnabled) return;

        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            // Handle status messages
            if (sender === 'status@broadcast') {
                return this.handleStatusUpdate(whatsappMsg, text);
            }

            // Create user mapping if not exists
            await this.createUserMapping(participant, whatsappMsg);
            
            // Get or create topic for this chat
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            
            // Format message for Telegram
            const formattedMessage = await this.formatWhatsAppMessage(whatsappMsg, text);
            
            // Send to Telegram
            await this.sendToTelegram(topicId, formattedMessage, whatsappMsg);

            // Log message to database
            await this.database.logMessage({
                whatsappMessageId: whatsappMsg.key.id,
                whatsappJid: sender,
                telegramTopicId: topicId,
                messageType: this.getMessageType(whatsappMsg),
                content: text || '',
                direction: 'wa_to_tg'
            });

        } catch (error) {
            logger.error('❌ Error syncing message:', error);
        }
    }

    async handleStatusUpdate(whatsappMsg, text) {
        if (!this.settings.syncStatus || !this.systemTopics.status) return;

        const participant = whatsappMsg.key.participant;
        const userInfo = this.userMappings.get(participant);
        const chatId = config.get('telegram.chatId');

        const statusMessage = `📱 *Status Update*\n\n` +
                             `👤 ${userInfo ? userInfo.name : 'Unknown User'}\n` +
                             `📱 ${participant.split('@')[0]}\n` +
                             `🕐 ${new Date().toLocaleString()}\n\n` +
                             `💬 ${text || 'Media status'}`;

        await this.telegramBot.sendMessage(chatId, statusMessage, {
            message_thread_id: this.systemTopics.status,
            parse_mode: 'Markdown'
        });
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        let userName = 'Unknown User';
        let userPhone = participant.split('@')[0];
        let profilePicUrl = '';
        
        try {
            // Try to get contact info
            if (this.whatsappBot.sock) {
                try {
                    const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                    if (contact && contact[0]) {
                        userName = contact[0].notify || userPhone;
                    }
                } catch (error) {
                    logger.debug('Could not fetch contact info:', error);
                }

                // Try to get profile picture
                try {
                    const ppUrl = await this.whatsappBot.sock.profilePictureUrl(participant, 'image');
                    profilePicUrl = ppUrl;
                } catch (error) {
                    logger.debug('Could not fetch profile picture:', error);
                }
            }
        } catch (error) {
            logger.debug('Error creating user mapping:', error);
        }

        const userMapping = {
            name: userName,
            phone: userPhone,
            profilePicUrl,
            firstSeen: new Date(),
            messageCount: 0
        };

        this.userMappings.set(participant, userMapping);

        // Save to database
        await this.database.saveContact({
            jid: participant,
            name: userName,
            phone: userPhone,
            profilePicUrl,
            isGroup: participant.endsWith('@g.us'),
            lastSeen: new Date(),
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
            let profilePicUrl = '';
            
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `👥 ${groupMeta.subject}`;
                    
                    // Try to get group profile picture
                    try {
                        profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(chatJid, 'image');
                    } catch (error) {
                        logger.debug('Could not fetch group profile picture:', error);
                    }
                } catch (error) {
                    topicName = `👥 Group Chat`;
                }
            } else {
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                topicName = `👤 ${userInfo ? userInfo.name : 'Private Chat'}`;
                profilePicUrl = userInfo ? userInfo.profilePicUrl : '';
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            
            // Save to database
            await this.database.saveTopicMapping({
                whatsappJid: chatJid,
                telegramTopicId: topic.message_thread_id,
                topicName,
                isGroup,
                isActive: true,
                messageCount: 0,
                lastActivity: new Date()
            });

            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message with profile picture
            await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup, profilePicUrl);
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, chatJid, isGroup, profilePicUrl) {
        const chatId = config.get('telegram.chatId');
        const welcomeMsg = `🔗 *WhatsApp Bridge Connected*\n\n` +
                          `📱 Chat Type: ${isGroup ? 'Group' : 'Private'}\n` +
                          `🆔 WhatsApp ID: \`${chatJid}\`\n` +
                          `⏰ Connected: ${new Date().toLocaleString()}\n\n` +
                          `💬 Messages from this WhatsApp chat will appear here.\n` +
                          `📤 Reply to messages here to send back to WhatsApp.`;

        // Send profile picture if available
        if (profilePicUrl) {
            try {
                await this.telegramBot.sendPhoto(chatId, profilePicUrl, {
                    message_thread_id: topicId,
                    caption: welcomeMsg,
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                // Fallback to text message if photo fails
                await this.telegramBot.sendMessage(chatId, welcomeMsg, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }
        } else {
            await this.telegramBot.sendMessage(chatId, welcomeMsg, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
    }

    async formatWhatsAppMessage(whatsappMsg, text) {
        const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
        const userInfo = this.userMappings.get(participant);
        const timestamp = new Date().toLocaleTimeString();
        
        let formattedText = `👤 *${userInfo ? userInfo.name : 'Unknown'}*\n`;
        formattedText += `📱 ${userInfo ? userInfo.phone : 'Unknown'}\n`;
        formattedText += `🕐 ${timestamp}\n\n`;
        
        if (text) {
            formattedText += `💬 ${text}`;
        }

        // Handle media messages
        const messageType = this.getMessageType(whatsappMsg);
        switch (messageType) {
            case 'image':
                formattedText += `📷 *Image Message*`;
                break;
            case 'video':
                formattedText += `🎥 *Video Message*`;
                break;
            case 'audio':
                formattedText += `🎵 *Audio Message*`;
                break;
            case 'voice':
                formattedText += `🎤 *Voice Message*`;
                break;
            case 'document':
                formattedText += `📄 *Document Message*`;
                break;
            case 'sticker':
                formattedText += `🎭 *Sticker Message*`;
                break;
        }

        return formattedText;
    }

    getMessageType(whatsappMsg) {
        if (whatsappMsg.message?.imageMessage) return 'image';
        if (whatsappMsg.message?.videoMessage) return 'video';
        if (whatsappMsg.message?.audioMessage) {
            return whatsappMsg.message.audioMessage.ptt ? 'voice' : 'audio';
        }
        if (whatsappMsg.message?.documentMessage) return 'document';
        if (whatsappMsg.message?.stickerMessage) return 'sticker';
        return 'text';
    }

    async sendToTelegram(topicId, message, whatsappMsg) {
        if (!topicId) return;

        const chatId = config.get('telegram.chatId');
        
        try {
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '↩️ Reply', callback_data: `reply_${whatsappMsg.key.id}` },
                        { text: '👤 User Info', callback_data: `info_${whatsappMsg.key.participant || whatsappMsg.key.remoteJid}` }
                    ]
                ]
            };

            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

            // Update user message count
            const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
            if (this.userMappings.has(participant)) {
                this.userMappings.get(participant).messageCount++;
            }

        } catch (error) {
            logger.error('❌ Failed to send message to Telegram:', error);
        }
    }

    async handleTelegramMessage(msg) {
        if (!msg.reply_to_message || !this.bridgeEnabled) return;

        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            let messageContent;

            // Handle different message types
            if (msg.text) {
                messageContent = { text: `📱 *From Telegram:*\n${msg.text}` };
            } else if (msg.voice) {
                // Handle voice messages
                await this.handleVoiceMessage(msg);
                return;
            } else if (msg.video_note) {
                // Handle video notes
                await this.handleVideoNote(msg);
                return;
            } else {
                messageContent = { text: '📱 *From Telegram:* [Media message]' };
            }

            await this.whatsappBot.sendMessage(whatsappJid, messageContent);
            
            await this.telegramBot.sendMessage(msg.chat.id, '✅ Message sent to WhatsApp', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
        }
    }

    async handleVoiceMessage(msg) {
        // Convert Telegram voice to WhatsApp voice message
        // Implementation would involve downloading, converting, and sending
        await this.telegramBot.sendMessage(msg.chat.id, '🎤 Voice message conversion coming soon!', {
            message_thread_id: msg.message_thread_id
        });
    }

    async handleVideoNote(msg) {
        // Convert Telegram video note to WhatsApp video
        await this.telegramBot.sendMessage(msg.chat.id, '🎥 Video note conversion coming soon!', {
            message_thread_id: msg.message_thread_id
        });
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    async syncAllContacts() {
        try {
            const contacts = await this.database.getAllContacts();
            
            for (const contact of contacts) {
                // Update contact info and profile picture
                await this.updateContactInfo(contact.jid);
            }

            logger.info(`✅ Synced ${contacts.length} contacts`);
        } catch (error) {
            logger.error('❌ Error syncing contacts:', error);
        }
    }

    async updateContactInfo(jid) {
        try {
            if (!this.whatsappBot.sock) return;

            let userName = jid.split('@')[0];
            let profilePicUrl = '';

            // Get contact name
            try {
                const contact = await this.whatsappBot.sock.onWhatsApp(jid);
                if (contact && contact[0]) {
                    userName = contact[0].notify || userName;
                }
            } catch (error) {
                logger.debug('Could not fetch contact info:', error);
            }

            // Get profile picture
            try {
                profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            } catch (error) {
                logger.debug('Could not fetch profile picture:', error);
            }

            // Update database
            await this.database.saveContact({
                jid,
                name: userName,
                phone: jid.split('@')[0],
                profilePicUrl,
                isGroup: jid.endsWith('@g.us'),
                lastSeen: new Date()
            });

            // Update user mapping
            if (this.userMappings.has(jid)) {
                const userInfo = this.userMappings.get(jid);
                userInfo.name = userName;
                userInfo.profilePicUrl = profilePicUrl;
            }

        } catch (error) {
            logger.error(`❌ Error updating contact ${jid}:`, error);
        }
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

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: ${this.bridgeEnabled ? 'Active' : 'Inactive'}\n` +
            `📊 Database: ${this.database.isConnected ? 'Connected' : 'Disconnected'}\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
            logger.info('📱 Telegram bridge stopped');
        }
        
        if (this.database) {
            await this.database.disconnect();
        }
    }
}

module.exports = TelegramBridge;
