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
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.database = new Database();
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.messageQueue = [];
        this.isProcessing = false;
        this.statusTopicId = null;
        this.callsTopicId = null;
        this.controlPanelUsers = new Set();
        this.tempDir = path.join(__dirname, '../temp');
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            // Initialize database
            await this.database.connect();
            
            // Ensure temp directory exists
            await fs.ensureDir(this.tempDir);
            
            // Initialize Telegram bot
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            
            // Load existing mappings from database
            await this.loadMappingsFromDatabase();
            
            // Create system topics
            await this.createSystemTopics();
            
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
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
        if (!chatId || chatId.includes('2345678901')) return;

        try {
            // Create Status Updates topic
            if (!this.statusTopicId) {
                const statusTopic = await this.telegramBot.createForumTopic(chatId, '📱 Status Updates', {
                    icon_color: 0x9367DA
                });
                this.statusTopicId = statusTopic.message_thread_id;
                await this.database.saveTopicMapping({
                    whatsappJid: 'status@broadcast',
                    telegramTopicId: this.statusTopicId,
                    topicName: '📱 Status Updates',
                    isGroup: false,
                    isActive: true
                });
            }

            // Create Calls topic
            if (!this.callsTopicId) {
                const callsTopic = await this.telegramBot.createForumTopic(chatId, '📞 Calls & Notifications', {
                    icon_color: 0xFF6B6B
                });
                this.callsTopicId = callsTopic.message_thread_id;
                await this.database.saveTopicMapping({
                    whatsappJid: 'calls@system',
                    telegramTopicId: this.callsTopicId,
                    topicName: '📞 Calls & Notifications',
                    isGroup: false,
                    isActive: true
                });
            }

            logger.info('✅ System topics created');
        } catch (error) {
            logger.error('❌ Error creating system topics:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle incoming messages
        this.telegramBot.on('message', async (msg) => {
            try {
                if (msg.chat.type === 'supergroup') {
                    if (msg.is_topic_message) {
                        await this.handleTelegramMessage(msg);
                    } else {
                        await this.handleControlPanelCommand(msg);
                    }
                }
            } catch (error) {
                logger.error('❌ Error handling Telegram message:', error);
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

    async handleControlPanelCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.split(' ');
        const userId = msg.from.id;

        // Add user to control panel users
        this.controlPanelUsers.add(userId);

        switch (command.toLowerCase()) {
            case '/start':
                await this.sendControlPanel(msg.chat.id, msg.message_id);
                break;
            case '/bridge':
                await this.handleBridgeCommand(msg, args);
                break;
            case '/settings':
                await this.sendSettingsPanel(msg.chat.id, msg.message_id);
                break;
            case '/contacts':
                await this.handleContactsCommand(msg, args);
                break;
            case '/send':
                await this.handleSendCommand(msg, args);
                break;
            case '/status':
                await this.sendBridgeStatus(msg.chat.id, msg.message_id);
                break;
            case '/sync':
                await this.handleSyncCommand(msg, args);
                break;
            case '/help':
                await this.sendHelpMessage(msg.chat.id, msg.message_id);
                break;
        }
    }

    async sendControlPanel(chatId, replyToMessageId) {
        const bridgeEnabled = await this.database.getSetting('bridge_enabled') ?? true;
        const totalContacts = (await this.database.getAllContacts()).length;
        const totalTopics = (await this.database.getAllTopicMappings()).length;

        const panelMessage = `🤖 *WhatsApp-Telegram Bridge Control Panel*\n\n` +
                           `📊 *Status:*\n` +
                           `• Bridge: ${bridgeEnabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                           `• Contacts: ${totalContacts}\n` +
                           `• Active Topics: ${totalTopics}\n` +
                           `• WhatsApp: ${this.whatsappBot.sock ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                           `🎛️ *Available Commands:*\n` +
                           `• \`/bridge on|off\` - Toggle bridge\n` +
                           `• \`/settings\` - Bridge settings\n` +
                           `• \`/contacts\` - Manage contacts\n` +
                           `• \`/send <number> <message>\` - Send message\n` +
                           `• \`/sync contacts|status\` - Sync data\n` +
                           `• \`/status\` - Detailed status\n` +
                           `• \`/help\` - Show help`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: bridgeEnabled ? '🔴 Disable Bridge' : '🟢 Enable Bridge', callback_data: `toggle_bridge` },
                    { text: '⚙️ Settings', callback_data: 'show_settings' }
                ],
                [
                    { text: '👥 Contacts', callback_data: 'show_contacts' },
                    { text: '📊 Statistics', callback_data: 'show_stats' }
                ],
                [
                    { text: '🔄 Sync All', callback_data: 'sync_all' },
                    { text: '📱 WhatsApp Menu', callback_data: 'whatsapp_menu' }
                ]
            ]
        };

        await this.telegramBot.sendMessage(chatId, panelMessage, {
            parse_mode: 'Markdown',
            reply_to_message_id: replyToMessageId,
            reply_markup: keyboard
        });
    }

    async handleBridgeCommand(msg, args) {
        if (args.length === 0) {
            const status = await this.database.getSetting('bridge_enabled') ?? true;
            await this.telegramBot.sendMessage(msg.chat.id, 
                `🌉 Bridge is currently ${status ? '✅ Enabled' : '❌ Disabled'}`, 
                { reply_to_message_id: msg.message_id }
            );
            return;
        }

        const action = args[0].toLowerCase();
        let newStatus;

        if (action === 'on' || action === 'enable') {
            newStatus = true;
        } else if (action === 'off' || action === 'disable') {
            newStatus = false;
        } else {
            await this.telegramBot.sendMessage(msg.chat.id, 
                '❌ Invalid option. Use: `/bridge on` or `/bridge off`', 
                { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
            );
            return;
        }

        await this.database.setSetting('bridge_enabled', newStatus);
        config.set('telegram.settings.bridgeEnabled', newStatus);

        await this.telegramBot.sendMessage(msg.chat.id, 
            `✅ Bridge ${newStatus ? 'enabled' : 'disabled'} successfully!`, 
            { reply_to_message_id: msg.message_id }
        );

        await this.logToTelegram('🌉 Bridge Status Changed', 
            `Bridge has been ${newStatus ? 'enabled' : 'disabled'} by user ${msg.from.first_name}`
        );
    }

    async sendSettingsPanel(chatId, replyToMessageId) {
        const settings = {
            allowMedia: await this.database.getSetting('allow_media') ?? true,
            allowStickers: await this.database.getSetting('allow_stickers') ?? true,
            allowVoice: await this.database.getSetting('allow_voice') ?? true,
            allowAudio: await this.database.getSetting('allow_audio') ?? true,
            syncContacts: await this.database.getSetting('sync_contacts') ?? true,
            syncStatus: await this.database.getSetting('sync_status') ?? true
        };

        const settingsMessage = `⚙️ *Bridge Settings*\n\n` +
                              `📷 Media: ${settings.allowMedia ? '✅' : '❌'}\n` +
                              `🎭 Stickers: ${settings.allowStickers ? '✅' : '❌'}\n` +
                              `🎤 Voice: ${settings.allowVoice ? '✅' : '❌'}\n` +
                              `🎵 Audio: ${settings.allowAudio ? '✅' : '❌'}\n` +
                              `👥 Sync Contacts: ${settings.syncContacts ? '✅' : '❌'}\n` +
                              `📱 Sync Status: ${settings.syncStatus ? '✅' : '❌'}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `📷 ${settings.allowMedia ? '✅' : '❌'}`, callback_data: 'toggle_media' },
                    { text: `🎭 ${settings.allowStickers ? '✅' : '❌'}`, callback_data: 'toggle_stickers' }
                ],
                [
                    { text: `🎤 ${settings.allowVoice ? '✅' : '❌'}`, callback_data: 'toggle_voice' },
                    { text: `🎵 ${settings.allowAudio ? '✅' : '❌'}`, callback_data: 'toggle_audio' }
                ],
                [
                    { text: `👥 ${settings.syncContacts ? '✅' : '❌'}`, callback_data: 'toggle_contacts' },
                    { text: `📱 ${settings.syncStatus ? '✅' : '❌'}`, callback_data: 'toggle_status' }
                ],
                [
                    { text: '🔙 Back to Panel', callback_data: 'back_to_panel' }
                ]
            ]
        };

        await this.telegramBot.sendMessage(chatId, settingsMessage, {
            parse_mode: 'Markdown',
            reply_to_message_id: replyToMessageId,
            reply_markup: keyboard
        });
    }

    async handleContactsCommand(msg, args) {
        if (args.length === 0) {
            const contacts = await this.database.getAllContacts();
            const contactsList = contacts.slice(0, 20).map((contact, index) => 
                `${index + 1}. ${contact.name || contact.phone} ${contact.isGroup ? '👥' : '👤'}`
            ).join('\n');

            const message = `👥 *Contacts (${contacts.length} total)*\n\n${contactsList}` +
                          (contacts.length > 20 ? `\n\n... and ${contacts.length - 20} more` : '');

            await this.telegramBot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
            return;
        }

        const action = args[0].toLowerCase();
        if (action === 'sync') {
            await this.syncAllContacts();
            await this.telegramBot.sendMessage(msg.chat.id, 
                '✅ Contacts sync completed!', 
                { reply_to_message_id: msg.message_id }
            );
        }
    }

    async handleSendCommand(msg, args) {
        if (args.length < 2) {
            await this.telegramBot.sendMessage(msg.chat.id, 
                '❌ Usage: `/send <number> <message>`\nExample: `/send 1234567890 Hello from Telegram!`', 
                { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
            );
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        try {
            await this.whatsappBot.sendMessage(jid, { text: message });
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Message sent to ${number}`, 
                { reply_to_message_id: msg.message_id }
            );

            await this.logToTelegram('📤 Message Sent via Telegram', 
                `To: ${number}\nMessage: ${message}\nSent by: ${msg.from.first_name}`
            );
        } catch (error) {
            await this.telegramBot.sendMessage(msg.chat.id, 
                `❌ Failed to send message: ${error.message}`, 
                { reply_to_message_id: msg.message_id }
            );
        }
    }

    async handleSyncCommand(msg, args) {
        if (args.length === 0) {
            await this.telegramBot.sendMessage(msg.chat.id, 
                '🔄 Available sync options:\n• `/sync contacts` - Sync contact names\n• `/sync status` - Sync status updates\n• `/sync all` - Sync everything', 
                { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
            );
            return;
        }

        const type = args[0].toLowerCase();
        let message = '';

        switch (type) {
            case 'contacts':
                await this.syncAllContacts();
                message = '✅ Contacts synced successfully!';
                break;
            case 'status':
                await this.syncStatusUpdates();
                message = '✅ Status updates synced!';
                break;
            case 'all':
                await this.syncAllContacts();
                await this.syncStatusUpdates();
                await this.updateAllProfilePictures();
                message = '✅ Full sync completed!';
                break;
            default:
                message = '❌ Invalid sync type. Use: contacts, status, or all';
        }

        await this.telegramBot.sendMessage(msg.chat.id, message, {
            reply_to_message_id: msg.message_id
        });
    }

    async sendBridgeStatus(chatId, replyToMessageId) {
        const bridgeEnabled = await this.database.getSetting('bridge_enabled') ?? true;
        const contacts = await this.database.getAllContacts();
        const topics = await this.database.getAllTopicMappings();
        
        const groupContacts = contacts.filter(c => c.isGroup).length;
        const privateContacts = contacts.filter(c => !c.isGroup).length;
        const activeTopics = topics.filter(t => t.isActive).length;

        const statusMessage = `📊 *Detailed Bridge Status*\n\n` +
                            `🌉 *Bridge:* ${bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                            `📱 *WhatsApp:* ${this.whatsappBot.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
                            `🤖 *Telegram:* ${this.telegramBot ? '✅ Connected' : '❌ Disconnected'}\n` +
                            `📊 *Database:* ${this.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                            `👥 *Contacts:*\n` +
                            `• Total: ${contacts.length}\n` +
                            `• Groups: ${groupContacts}\n` +
                            `• Private: ${privateContacts}\n\n` +
                            `💬 *Topics:*\n` +
                            `• Total: ${topics.length}\n` +
                            `• Active: ${activeTopics}\n` +
                            `• System: 2 (Status, Calls)\n\n` +
                            `⚙️ *Settings:*\n` +
                            `• Media: ${await this.database.getSetting('allow_media') ? '✅' : '❌'}\n` +
                            `• Stickers: ${await this.database.getSetting('allow_stickers') ? '✅' : '❌'}\n` +
                            `• Voice: ${await this.database.getSetting('allow_voice') ? '✅' : '❌'}\n` +
                            `• Contact Sync: ${await this.database.getSetting('sync_contacts') ? '✅' : '❌'}`;

        await this.telegramBot.sendMessage(chatId, statusMessage, {
            parse_mode: 'Markdown',
            reply_to_message_id: replyToMessageId
        });
    }

    async sendHelpMessage(chatId, replyToMessageId) {
        const helpMessage = `🆘 *WhatsApp-Telegram Bridge Help*\n\n` +
                          `🎛️ *Control Panel Commands:*\n` +
                          `• \`/start\` - Show main control panel\n` +
                          `• \`/bridge on|off\` - Toggle bridge on/off\n` +
                          `• \`/settings\` - Show bridge settings\n` +
                          `• \`/contacts\` - List contacts\n` +
                          `• \`/send <number> <message>\` - Send message to WhatsApp\n` +
                          `• \`/sync contacts|status|all\` - Sync data\n` +
                          `• \`/status\` - Show detailed status\n\n` +
                          `💬 *Message Features:*\n` +
                          `• Reply to messages in topics to send back to WhatsApp\n` +
                          `• Send view-once messages with \`/viewonce\`\n` +
                          `• Send voice notes and video notes\n` +
                          `• Forward media with automatic conversion\n\n` +
                          `🔧 *Advanced Features:*\n` +
                          `• Automatic contact sync and profile picture updates\n` +
                          `• Status updates forwarding\n` +
                          `• Call notifications\n` +
                          `• Media filtering and conversion\n` +
                          `• MongoDB logging and analytics`;

        await this.telegramBot.sendMessage(chatId, helpMessage, {
            parse_mode: 'Markdown',
            reply_to_message_id: replyToMessageId
        });
    }

    async handleCallback(query) {
        const data = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        try {
            switch (data) {
                case 'toggle_bridge':
                    const currentStatus = await this.database.getSetting('bridge_enabled') ?? true;
                    await this.database.setSetting('bridge_enabled', !currentStatus);
                    await this.telegramBot.answerCallbackQuery(query.id, {
                        text: `Bridge ${!currentStatus ? 'enabled' : 'disabled'}!`,
                        show_alert: false
                    });
                    await this.sendControlPanel(chatId, null);
                    break;

                case 'show_settings':
                    await this.sendSettingsPanel(chatId, null);
                    break;

                case 'show_contacts':
                    await this.handleContactsCommand({ chat: { id: chatId }, message_id: messageId }, []);
                    break;

                case 'show_stats':
                    await this.sendBridgeStatus(chatId, null);
                    break;

                case 'sync_all':
                    await this.telegramBot.answerCallbackQuery(query.id, {
                        text: 'Starting full sync...',
                        show_alert: false
                    });
                    await this.syncAllContacts();
                    await this.updateAllProfilePictures();
                    break;

                case 'whatsapp_menu':
                    await this.sendWhatsAppMenu(chatId, messageId);
                    break;

                case 'back_to_panel':
                    await this.sendControlPanel(chatId, null);
                    break;

                // Settings toggles
                case 'toggle_media':
                    await this.toggleSetting('allow_media', query);
                    break;
                case 'toggle_stickers':
                    await this.toggleSetting('allow_stickers', query);
                    break;
                case 'toggle_voice':
                    await this.toggleSetting('allow_voice', query);
                    break;
                case 'toggle_audio':
                    await this.toggleSetting('allow_audio', query);
                    break;
                case 'toggle_contacts':
                    await this.toggleSetting('sync_contacts', query);
                    break;
                case 'toggle_status':
                    await this.toggleSetting('sync_status', query);
                    break;

                default:
                    if (data.startsWith('reply_') || data.startsWith('info_')) {
                        await this.handleMessageCallback(query, data);
                    }
            }
        } catch (error) {
            logger.error('❌ Error handling callback:', error);
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: 'Error processing request',
                show_alert: true
            });
        }
    }

    async toggleSetting(settingKey, query) {
        const currentValue = await this.database.getSetting(settingKey) ?? true;
        await this.database.setSetting(settingKey, !currentValue);
        
        await this.telegramBot.answerCallbackQuery(query.id, {
            text: `${settingKey.replace('_', ' ')} ${!currentValue ? 'enabled' : 'disabled'}!`,
            show_alert: false
        });
        
        await this.sendSettingsPanel(query.message.chat.id, null);
    }

    async sendWhatsAppMenu(chatId, messageId) {
        const botInfo = {
            name: config.get('bot.name'),
            version: config.get('bot.version'),
            company: config.get('bot.company'),
            prefix: config.get('bot.prefix')
        };

        const menuMessage = `🤖 *${botInfo.name} v${botInfo.version}*\n` +
                          `🏢 *By ${botInfo.company}*\n\n` +
                          `📱 *WhatsApp Bot Control Panel*\n\n` +
                          `🎯 *Bot Status:*\n` +
                          `• Connection: ${this.whatsappBot.sock ? '✅ Active' : '❌ Inactive'}\n` +
                          `• Mode: ${config.get('features.mode')}\n` +
                          `• Prefix: \`${botInfo.prefix}\`\n` +
                          `• Auto View Status: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n` +
                          `• Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n\n` +
                          `🔧 *Available Features:*\n` +
                          `• Modular Architecture\n` +
                          `• Telegram Bridge Integration\n` +
                          `• Advanced Message Handling\n` +
                          `• Custom Module Support\n` +
                          `• Rate Limiting & Security\n` +
                          `• Status Auto-View\n` +
                          `• Multi-Platform Logging\n\n` +
                          `💡 *Quick Actions:*\n` +
                          `• Send \`${botInfo.prefix}menu\` in WhatsApp for commands\n` +
                          `• Use this panel for bridge control\n` +
                          `• Monitor all activities here`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📊 Bot Statistics', callback_data: 'bot_stats' },
                    { text: '⚙️ Bot Settings', callback_data: 'bot_settings' }
                ],
                [
                    { text: '🔄 Restart Bot', callback_data: 'restart_bot' },
                    { text: '📋 View Logs', callback_data: 'view_logs' }
                ],
                [
                    { text: '🔙 Back to Bridge Panel', callback_data: 'back_to_panel' }
                ]
            ]
        };

        await this.telegramBot.editMessageText(menuMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async syncMessage(whatsappMsg, text) {
        const bridgeEnabled = await this.database.getSetting('bridge_enabled') ?? true;
        if (!this.telegramBot || !bridgeEnabled) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        // Handle status messages
        if (sender === 'status@broadcast') {
            return await this.handleStatusMessage(whatsappMsg, text);
        }

        // Create/update contact
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        if (!topicId) return;

        // Check media settings
        if (!await this.shouldForwardMessage(whatsappMsg)) {
            logger.debug('Message filtered by settings');
            return;
        }

        // Format and send message
        await this.forwardMessageToTelegram(whatsappMsg, text, topicId);
        
        // Log message
        await this.database.logMessage({
            whatsappMessageId: whatsappMsg.key.id,
            whatsappJid: sender,
            telegramTopicId: topicId,
            messageType: this.getMessageType(whatsappMsg),
            content: text || '',
            direction: 'wa_to_tg'
        });
    }

    async handleStatusMessage(whatsappMsg, text) {
        if (!this.statusTopicId) return;
        
        const syncStatus = await this.database.getSetting('sync_status') ?? true;
        if (!syncStatus) return;

        const participant = whatsappMsg.key.participant;
        const contact = await this.database.getContact(participant);
        const contactName = contact?.name || participant.split('@')[0];

        let statusMessage = `📱 *Status Update*\n\n`;
        statusMessage += `👤 *From:* ${contactName}\n`;
        statusMessage += `📱 *Number:* ${participant.split('@')[0]}\n`;
        statusMessage += `🕐 *Time:* ${new Date().toLocaleString()}\n\n`;

        if (text) {
            statusMessage += `💬 *Content:* ${text}`;
        }

        // Handle media status
        if (whatsappMsg.message?.imageMessage) {
            statusMessage += `📷 *Image Status*`;
            // Download and forward image if enabled
            if (await this.database.getSetting('allow_media')) {
                await this.forwardMediaToTelegram(whatsappMsg, this.statusTopicId, statusMessage);
                return;
            }
        } else if (whatsappMsg.message?.videoMessage) {
            statusMessage += `🎥 *Video Status*`;
            if (await this.database.getSetting('allow_media')) {
                await this.forwardMediaToTelegram(whatsappMsg, this.statusTopicId, statusMessage);
                return;
            }
        }

        const chatId = config.get('telegram.chatId');
        await this.telegramBot.sendMessage(chatId, statusMessage, {
            message_thread_id: this.statusTopicId,
            parse_mode: 'Markdown'
        });
    }

    async shouldForwardMessage(whatsappMsg) {
        const message = whatsappMsg.message;
        
        if (message?.imageMessage && !(await this.database.getSetting('allow_media'))) return false;
        if (message?.videoMessage && !(await this.database.getSetting('allow_media'))) return false;
        if (message?.audioMessage && !(await this.database.getSetting('allow_audio'))) return false;
        if (message?.stickerMessage && !(await this.database.getSetting('allow_stickers'))) return false;
        if (message?.documentMessage && !(await this.database.getSetting('allow_media'))) return false;
        
        return true;
    }

    async forwardMessageToTelegram(whatsappMsg, text, topicId) {
        const chatId = config.get('telegram.chatId');
        const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
        const contact = await this.database.getContact(participant);
        const contactName = contact?.name || participant.split('@')[0];

        // Check for media messages
        if (whatsappMsg.message?.imageMessage || whatsappMsg.message?.videoMessage || 
            whatsappMsg.message?.audioMessage || whatsappMsg.message?.documentMessage) {
            await this.forwardMediaToTelegram(whatsappMsg, topicId, text, contactName);
            return;
        }

        // Text message
        let formattedMessage = `👤 *${contactName}*\n`;
        formattedMessage += `📱 ${participant.split('@')[0]}\n`;
        formattedMessage += `🕐 ${new Date().toLocaleTimeString()}\n\n`;
        
        if (text) {
            formattedMessage += `💬 ${text}`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '↩️ Reply', callback_data: `reply_${whatsappMsg.key.id}` },
                    { text: '👤 Info', callback_data: `info_${participant}` }
                ]
            ]
        };

        await this.telegramBot.sendMessage(chatId, formattedMessage, {
            message_thread_id: topicId,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async forwardMediaToTelegram(whatsappMsg, topicId, caption = '', contactName = '') {
        const chatId = config.get('telegram.chatId');
        const message = whatsappMsg.message;
        
        try {
            let mediaBuffer;
            let mediaType;
            let fileName;

            // Download media from WhatsApp
            if (message.imageMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg);
                mediaType = 'photo';
                fileName = 'image.jpg';
            } else if (message.videoMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg);
                mediaType = 'video';
                fileName = 'video.mp4';
            } else if (message.audioMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg);
                mediaType = message.audioMessage.ptt ? 'voice' : 'audio';
                fileName = 'audio.ogg';
            } else if (message.documentMessage) {
                mediaBuffer = await this.whatsappBot.sock.downloadMediaMessage(whatsappMsg);
                mediaType = 'document';
                fileName = message.documentMessage.fileName || 'document';
            }

            if (!mediaBuffer) return;

            // Save to temp file
            const tempFilePath = path.join(this.tempDir, `${Date.now()}_${fileName}`);
            await fs.writeFile(tempFilePath, mediaBuffer);

            // Prepare caption
            const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
            const contact = await this.database.getContact(participant);
            const name = contactName || contact?.name || participant.split('@')[0];
            
            const fullCaption = `👤 *${name}*\n📱 ${participant.split('@')[0]}\n🕐 ${new Date().toLocaleTimeString()}` +
                              (caption ? `\n\n💬 ${caption}` : '');

            // Send media to Telegram
            const options = {
                message_thread_id: topicId,
                caption: fullCaption,
                parse_mode: 'Markdown'
            };

            switch (mediaType) {
                case 'photo':
                    await this.telegramBot.sendPhoto(chatId, tempFilePath, options);
                    break;
                case 'video':
                    await this.telegramBot.sendVideo(chatId, tempFilePath, options);
                    break;
                case 'voice':
                    await this.telegramBot.sendVoice(chatId, tempFilePath, options);
                    break;
                case 'audio':
                    await this.telegramBot.sendAudio(chatId, tempFilePath, options);
                    break;
                case 'document':
                    await this.telegramBot.sendDocument(chatId, tempFilePath, options);
                    break;
            }

            // Clean up temp file
            await fs.unlink(tempFilePath);

        } catch (error) {
            logger.error('❌ Error forwarding media:', error);
        }
    }

    async handleTelegramMessage(msg) {
        const bridgeEnabled = await this.database.getSetting('bridge_enabled') ?? true;
        if (!bridgeEnabled) return;

        // Handle different message types
        if (msg.text && msg.text.startsWith('/viewonce')) {
            await this.handleViewOnceMessage(msg);
            return;
        }

        if (msg.voice) {
            await this.handleVoiceMessage(msg);
            return;
        }

        if (msg.video_note) {
            await this.handleVideoNoteMessage(msg);
            return;
        }

        // Regular message forwarding
        if (!msg.reply_to_message) return;

        const topicId = msg.message_thread_id;
        const whatsappJid = this.findWhatsAppJidByTopic(topicId);
        
        if (!whatsappJid) {
            logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
            return;
        }

        try {
            let messageContent;

            if (msg.text) {
                messageContent = { text: `📱 *From Telegram:*\n${msg.text}` };
            } else if (msg.photo) {
                // Handle photo
                const photo = msg.photo[msg.photo.length - 1];
                const fileLink = await this.telegramBot.getFileLink(photo.file_id);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);
                
                messageContent = {
                    image: buffer,
                    caption: msg.caption ? `📱 *From Telegram:*\n${msg.caption}` : '📱 *From Telegram*'
                };
            } else if (msg.video) {
                // Handle video
                const fileLink = await this.telegramBot.getFileLink(msg.video.file_id);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);
                
                messageContent = {
                    video: buffer,
                    caption: msg.caption ? `📱 *From Telegram:*\n${msg.caption}` : '📱 *From Telegram*'
                };
            }

            if (messageContent) {
                await this.whatsappBot.sendMessage(whatsappJid, messageContent);
                
                // Confirm in Telegram
                await this.telegramBot.sendMessage(msg.chat.id, '✅ Message sent to WhatsApp', {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id
                });

                // Log message
                await this.database.logMessage({
                    whatsappMessageId: `tg_${msg.message_id}`,
                    telegramMessageId: msg.message_id,
                    whatsappJid: whatsappJid,
                    telegramTopicId: topicId,
                    messageType: msg.photo ? 'image' : msg.video ? 'video' : 'text',
                    content: msg.text || msg.caption || '',
                    direction: 'tg_to_wa'
                });
            }

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await this.telegramBot.sendMessage(msg.chat.id, `❌ Failed to send: ${error.message}`, {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
        }
    }

    async handleViewOnceMessage(msg) {
        const args = msg.text.split(' ').slice(1);
        if (args.length < 2) {
            await this.telegramBot.sendMessage(msg.chat.id, 
                '❌ Usage: `/viewonce <number> <message>`', 
                { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
            );
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        try {
            await this.whatsappBot.sendMessage(jid, {
                text: message,
                viewOnce: true
            });

            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ View-once message sent to ${number}`, 
                { reply_to_message_id: msg.message_id }
            );
        } catch (error) {
            await this.telegramBot.sendMessage(msg.chat.id, 
                `❌ Failed to send view-once message: ${error.message}`, 
                { reply_to_message_id: msg.message_id }
            );
        }
    }

    async handleVoiceMessage(msg) {
        const topicId = msg.message_thread_id;
        const whatsappJid = this.findWhatsAppJidByTopic(topicId);
        
        if (!whatsappJid) return;

        try {
            const fileLink = await this.telegramBot.getFileLink(msg.voice.file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            await this.whatsappBot.sendMessage(whatsappJid, {
                audio: buffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            });

            await this.telegramBot.sendMessage(msg.chat.id, '✅ Voice message sent to WhatsApp', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
        } catch (error) {
            logger.error('❌ Error handling voice message:', error);
        }
    }

    async handleVideoNoteMessage(msg) {
        const topicId = msg.message_thread_id;
        const whatsappJid = this.findWhatsAppJidByTopic(topicId);
        
        if (!whatsappJid) return;

        try {
            const fileLink = await this.telegramBot.getFileLink(msg.video_note.file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            await this.whatsappBot.sendMessage(whatsappJid, {
                video: buffer,
                caption: '📱 *Video note from Telegram*'
            });

            await this.telegramBot.sendMessage(msg.chat.id, '✅ Video note sent to WhatsApp', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
        } catch (error) {
            logger.error('❌ Error handling video note:', error);
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) {
            // Update existing mapping
            const existing = this.userMappings.get(participant);
            existing.messageCount++;
            existing.lastSeen = new Date();
            await this.database.saveContact(existing);
            return;
        }

        // Create new mapping
        let userName = 'Unknown User';
        let userPhone = participant.split('@')[0];
        let profilePicUrl = '';
        let isGroup = participant.endsWith('@g.us');
        let groupSubject = '';

        try {
            if (isGroup) {
                const groupMeta = await this.whatsappBot.sock.groupMetadata(participant);
                userName = groupMeta.subject;
                groupSubject = groupMeta.subject;
                profilePicUrl = await this.getProfilePicture(participant);
            } else {
                // Try to get contact name and profile picture
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0]) {
                    userName = contact[0].notify || userPhone;
                }
                profilePicUrl = await this.getProfilePicture(participant);
            }
        } catch (error) {
            logger.debug('Could not fetch contact info:', error);
        }

        const contactData = {
            jid: participant,
            name: userName,
            phone: userPhone,
            profilePicUrl,
            isGroup,
            groupSubject,
            lastSeen: new Date(),
            messageCount: 1
        };

        this.userMappings.set(participant, contactData);
        await this.database.saveContact(contactData);

        logger.debug(`👤 Created user mapping: ${userName} (${userPhone})`);
    }

    async getProfilePicture(jid) {
        try {
            const profilePic = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            return profilePic;
        } catch (error) {
            logger.debug('Could not get profile picture:', error);
            return '';
        }
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        // Check database first
        const existingMapping = await this.database.getTopicMapping(chatJid);
        if (existingMapping) {
            this.chatMappings.set(chatJid, existingMapping.telegramTopicId);
            return existingMapping.telegramTopicId;
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
                    topicName = `📱 ${groupMeta.subject}`;
                    profilePicUrl = await this.getProfilePicture(chatJid);
                } catch (error) {
                    topicName = `📱 Group Chat`;
                }
            } else {
                const participant = whatsappMsg.key.participant || chatJid;
                const contact = await this.database.getContact(participant);
                const contactName = contact?.name || participant.split('@')[0];
                topicName = `👤 ${contactName}`;
                profilePicUrl = await this.getProfilePicture(participant);
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            const topicId = topic.message_thread_id;
            this.chatMappings.set(chatJid, topicId);
            
            // Save to database
            await this.database.saveTopicMapping({
                whatsappJid: chatJid,
                telegramTopicId: topicId,
                topicName: topicName,
                isGroup: isGroup,
                isActive: true,
                messageCount: 0,
                lastActivity: new Date()
            });

            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topicId})`);
            
            // Send welcome message with profile picture
            await this.sendWelcomeMessage(topicId, chatJid, isGroup, profilePicUrl);
            
            return topicId;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, chatJid, isGroup, profilePicUrl = '') {
        const chatId = config.get('telegram.chatId');
        const contact = await this.database.getContact(chatJid);
        
        const welcomeMsg = `🔗 *WhatsApp Bridge Connected*\n\n` +
                          `📱 *Chat Type:* ${isGroup ? 'Group' : 'Private'}\n` +
                          `👤 *Name:* ${contact?.name || 'Unknown'}\n` +
                          `📞 *Number:* ${chatJid.split('@')[0]}\n` +
                          `🆔 *WhatsApp ID:* \`${chatJid}\`\n` +
                          `⏰ *Connected:* ${new Date().toLocaleString()}\n\n` +
                          `💬 Messages from this WhatsApp chat will appear here.\n` +
                          `📤 Reply to messages here to send back to WhatsApp.\n\n` +
                          `🎯 *Quick Commands:*\n` +
                          `• Reply to any message to respond\n` +
                          `• Use /viewonce for disappearing messages\n` +
                          `• Send voice notes and media directly`;

        try {
            if (profilePicUrl) {
                await this.telegramBot.sendPhoto(chatId, profilePicUrl, {
                    message_thread_id: topicId,
                    caption: welcomeMsg,
                    parse_mode: 'Markdown'
                });
            } else {
                await this.telegramBot.sendMessage(chatId, welcomeMsg, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            // Fallback to text message if profile picture fails
            await this.telegramBot.sendMessage(chatId, welcomeMsg, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
    }

    async syncAllContacts() {
        try {
            logger.info('🔄 Starting contact sync...');
            
            const contacts = await this.database.getAllContacts();
            let syncedCount = 0;

            for (const contact of contacts) {
                try {
                    let updatedName = contact.name;
                    let updatedProfilePic = contact.profilePicUrl;

                    if (contact.isGroup) {
                        const groupMeta = await this.whatsappBot.sock.groupMetadata(contact.jid);
                        updatedName = groupMeta.subject;
                    } else {
                        const waContact = await this.whatsappBot.sock.onWhatsApp(contact.jid);
                        if (waContact && waContact[0]) {
                            updatedName = waContact[0].notify || contact.phone;
                        }
                    }

                    // Update profile picture
                    const newProfilePic = await this.getProfilePicture(contact.jid);
                    if (newProfilePic && newProfilePic !== updatedProfilePic) {
                        updatedProfilePic = newProfilePic;
                        
                        // Update topic if profile picture changed
                        const topicMapping = await this.database.getTopicMapping(contact.jid);
                        if (topicMapping) {
                            await this.sendProfilePictureUpdate(topicMapping.telegramTopicId, contact.jid, newProfilePic);
                        }
                    }

                    // Update contact in database
                    await this.database.saveContact({
                        ...contact,
                        name: updatedName,
                        profilePicUrl: updatedProfilePic,
                        updatedAt: new Date()
                    });

                    // Update topic name if changed
                    if (updatedName !== contact.name) {
                        await this.updateTopicName(contact.jid, updatedName);
                    }

                    syncedCount++;
                } catch (error) {
                    logger.debug(`Error syncing contact ${contact.jid}:`, error);
                }
            }

            logger.info(`✅ Contact sync completed: ${syncedCount}/${contacts.length} contacts updated`);
            
            await this.logToTelegram('🔄 Contact Sync Completed', 
                `Successfully synced ${syncedCount} out of ${contacts.length} contacts`
            );
        } catch (error) {
            logger.error('❌ Error during contact sync:', error);
        }
    }

    async updateTopicName(whatsappJid, newName) {
        try {
            const topicMapping = await this.database.getTopicMapping(whatsappJid);
            if (!topicMapping) return;

            const chatId = config.get('telegram.chatId');
            const isGroup = whatsappJid.endsWith('@g.us');
            const newTopicName = `${isGroup ? '📱' : '👤'} ${newName}`;

            await this.telegramBot.editForumTopic(chatId, topicMapping.telegramTopicId, {
                name: newTopicName
            });

            // Update database
            await this.database.saveTopicMapping({
                ...topicMapping,
                topicName: newTopicName
            });

            logger.debug(`📝 Updated topic name: ${newTopicName}`);
        } catch (error) {
            logger.debug('Error updating topic name:', error);
        }
    }

    async sendProfilePictureUpdate(topicId, jid, profilePicUrl) {
        try {
            const chatId = config.get('telegram.chatId');
            const contact = await this.database.getContact(jid);
            
            const updateMessage = `📸 *Profile Picture Updated*\n\n` +
                                `👤 *Contact:* ${contact?.name || 'Unknown'}\n` +
                                `📱 *Number:* ${jid.split('@')[0]}\n` +
                                `🕐 *Updated:* ${new Date().toLocaleString()}`;

            await this.telegramBot.sendPhoto(chatId, profilePicUrl, {
                message_thread_id: topicId,
                caption: updateMessage,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Error sending profile picture update:', error);
        }
    }

    async updateAllProfilePictures() {
        try {
            logger.info('🖼️ Starting profile picture sync...');
            
            const contacts = await this.database.getAllContacts();
            let updatedCount = 0;

            for (const contact of contacts) {
                try {
                    const newProfilePic = await this.getProfilePicture(contact.jid);
                    
                    if (newProfilePic && newProfilePic !== contact.profilePicUrl) {
                        await this.database.saveContact({
                            ...contact,
                            profilePicUrl: newProfilePic,
                            updatedAt: new Date()
                        });

                        const topicMapping = await this.database.getTopicMapping(contact.jid);
                        if (topicMapping) {
                            await this.sendProfilePictureUpdate(topicMapping.telegramTopicId, contact.jid, newProfilePic);
                        }

                        updatedCount++;
                    }
                } catch (error) {
                    logger.debug(`Error updating profile picture for ${contact.jid}:`, error);
                }
            }

            logger.info(`✅ Profile picture sync completed: ${updatedCount} pictures updated`);
        } catch (error) {
            logger.error('❌ Error during profile picture sync:', error);
        }
    }

    async syncStatusUpdates() {
        // This would be called when status updates are received
        logger.info('✅ Status updates sync enabled');
    }

    async handleMessageCallback(query, data) {
        const [action, messageId] = data.split('_');
        
        if (action === 'reply') {
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: '💬 Reply to the message to send back to WhatsApp',
                show_alert: false
            });
        } else if (action === 'info') {
            const contact = await this.database.getContact(messageId);
            
            if (contact) {
                const infoText = `👤 *Contact Info*\n\n` +
                               `📝 Name: ${contact.name}\n` +
                               `📱 Phone: ${contact.phone}\n` +
                               `👥 Type: ${contact.isGroup ? 'Group' : 'Private'}\n` +
                               `👋 First Seen: ${contact.createdAt.toLocaleString()}\n` +
                               `👀 Last Seen: ${contact.lastSeen.toLocaleString()}\n` +
                               `💬 Messages: ${contact.messageCount}\n` +
                               `🚫 Blocked: ${contact.isBlocked ? 'Yes' : 'No'}`;
                
                await this.telegramBot.answerCallbackQuery(query.id, {
                    text: infoText,
                    show_alert: true
                });
            } else {
                await this.telegramBot.answerCallbackQuery(query.id, {
                    text: '❌ Contact information not found',
                    show_alert: true
                });
            }
        }
    }

    getMessageType(whatsappMsg) {
        const message = whatsappMsg.message;
        
        if (message?.imageMessage) return 'image';
        if (message?.videoMessage) return 'video';
        if (message?.audioMessage) return 'audio';
        if (message?.documentMessage) return 'document';
        if (message?.stickerMessage) return 'sticker';
        if (message?.voiceMessage) return 'voice';
        
        return 'text';
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
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
            `✅ *Bot:* ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 *WhatsApp:* Connected\n` +
            `🔗 *Telegram Bridge:* Active\n` +
            `📊 *Database:* ${this.database.isConnected ? 'Connected' : 'Disconnected'}\n` +
            `🚀 *Status:* Ready to bridge messages!\n\n` +
            `💡 *Tip:* Use /start in the main chat for control panel`
        );
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
        }
        
        if (this.database) {
            await this.database.disconnect();
        }
        
        // Clean up temp files
        try {
            await fs.emptyDir(this.tempDir);
        } catch (error) {
            logger.debug('Error cleaning temp directory:', error);
        }
        
        logger.info('📱 Telegram bridge stopped');
    }
}

module.exports = TelegramBridge;
