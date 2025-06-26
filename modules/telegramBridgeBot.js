const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');

class TelegramBridgeBot {
    constructor(token, bridge) {
        this.bot = new TelegramBot(token, { polling: true });
        this.bridge = bridge;
        this.isPolling = false;
    }

    async initialize() {
        try {
            // Check if already polling
            if (this.isPolling) {
                logger.warn('⚠️ Bot is already polling, skipping initialization');
                return;
            }

            // Clear any existing updates to prevent conflicts
            try {
                await this.bot.getUpdates({ offset: -1 });
                logger.info('✅ Cleared Telegram update queue');
            } catch (error) {
                logger.error('❌ Failed to clear update queue:', error);
            }

            await this.setupHandlers();
            this.isPolling = true;
            logger.info('📱 Telegram message handlers set up');
        } catch (error) {
            logger.error('❌ Failed to set up Telegram handlers:', error);
            if (error.message.includes('404')) {
                logger.error('❌ 404 Not Found: Invalid bot token or Telegram API unreachable');
            } else if (error.message.includes('409')) {
                logger.error('❌ 409 Conflict: Multiple polling instances detected');
            }
            throw error;
        }
    }

    async setupHandlers() {
        this.bot.onText(/\/start/, this.handleStart.bind(this));
        this.bot.onText(/\/bridge (.+)/, this.handleBridgeToggle.bind(this));
        this.bot.onText(/\/settings/, this.handleSettings.bind(this));
        this.bot.onText(/\/contacts/, this.handleContacts.bind(this));
        this.bot.onText(/\/send (.+)/, this.handleSendMessage.bind(this));
        this.bot.onText(/\/sync/, this.handleSync.bind(this));
        this.bot.onText(/\/status/, this.handleBridgeStatus.bind(this));
        this.bot.onText(/\/help/, this.handleHelp.bind(this));
        this.bot.onText(/\/viewonce/, this.handleViewOnce.bind(this));

        this.bot.on('message', async (msg) => {
            try {
                if (msg.chat.type === 'supergroup' && msg.is_topic_message && !msg.text?.startsWith('/')) {
                    await this.bridge.handleTelegramMessage(msg);
                }
            } catch (error) {
                logger.error('❌ Error handling Telegram message:', error);
            }
        });

        this.bot.on('polling_error', (error) => {
            logger.error('❌ Telegram polling error:', error);
            if (error.message.includes('404')) {
                logger.error('❌ 404 Not Found: Check bot token or Telegram API connectivity');
            } else if (error.message.includes('409')) {
                logger.error('❌ 409 Conflict: Multiple bot instances detected, stopping polling');
                this.stop();
            }
        });

        this.bot.on('error', (error) => {
            logger.error('❌ Telegram bot error:', error);
        });
    }

    async handleStart(msg) {
        const welcomeMessage = `🤖 *WhatsApp-Telegram Bridge Control Panel*\n\n` +
                              `🔗 Bridge Status: ${this.bridge.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                              `📱 Connected Chats: ${this.bridge.chatMappings.size}\n` +
                              `📊 Database: ${this.bridge.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n\n` +
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
                    { text: this.bridge.bridgeEnabled ? '🔴 Turn Off' : '🟢 Turn On', callback_data: 'toggle_bridge' },
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

        await this.sendMessage(msg.chat.id, welcomeMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleBridgeToggle(msg, match) {
        const action = match[1].toLowerCase();
        if (action === 'on') {
            this.bridge.bridgeEnabled = true;
            await this.bridge.database.setSetting('bridge_enabled', true);
            await this.sendMessage(msg.chat.id, '✅ Bridge enabled successfully!');
        } else if (action === 'off') {
            this.bridge.bridgeEnabled = false;
            await this.bridge.database.setSetting('bridge_enabled', false);
            await this.sendMessage(msg.chat.id, '❌ Bridge disabled successfully!');
        } else {
            await this.sendMessage(msg.chat.id, '❓ Usage: /bridge on|off');
        }
    }

    async handleSettings(msg) {
        const settingsMessage = `⚙️ *Bridge Settings*\n\n` +
                               `📷 Media: ${this.bridge.settings.allowMedia ? '✅' : '❌'}\n` +
                               `🎭 Stickers: ${this.bridge.settings.allowStickers ? '✅' : '❌'}\n` +
                               `🎵 Voice: ${this.bridge.settings.allowVoice ? '✅' : '❌'}\n` +
                               `🔊 Audio: ${this.bridge.settings.allowAudio ? '✅' : '❌'}\n` +
                               `📄 Documents: ${this.bridge.settings.allowDocuments ? '✅' : '❌'}\n` +
                               `🎥 Videos: ${this.bridge.settings.allowVideos ? '✅' : '❌'}\n` +
                               `👥 Sync Contacts: ${this.bridge.settings.syncContacts ? '✅' : '❌'}\n` +
                               `📱 Sync Status: ${this.bridge.settings.syncStatus ? '✅' : '❌'}\n` +
                               `📞 Sync Calls: ${this.bridge.settings.syncCalls ? '✅' : '❌'}\n` +
                               `🖼️ Auto Update Profile Pics: ${this.bridge.settings.autoUpdateProfilePics ? '✅' : '❌'}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `📷 Media ${this.bridge.settings.allowMedia ? '✅' : '❌'}`, callback_data: 'toggle_media' },
                    { text: `🎭 Stickers ${this.bridge.settings.allowStickers ? '✅' : '❌'}`, callback_data: 'toggle_stickers' }
                ],
                [
                    { text: `🎵 Voice ${this.bridge.settings.allowVoice ? '✅' : '❌'}`, callback_data: 'toggle_voice' },
                    { text: `🔊 Audio ${this.bridge.settings.allowAudio ? '✅' : '❌'}`, callback_data: 'toggle_audio' }
                ],
                [
                    { text: `📄 Docs ${this.bridge.settings.allowDocuments ? '✅' : '❌'}`, callback_data: 'toggle_documents' },
                    { text: `🎥 Videos ${this.bridge.settings.allowVideos ? '✅' : '❌'}`, callback_data: 'toggle_videos' }
                ],
                [
                    { text: `👥 Contacts ${this.bridge.settings.syncContacts ? '✅' : '❌'}`, callback_data: 'toggle_contacts' },
                    { text: `📱 Status ${this.bridge.settings.syncStatus ? '✅' : '❌'}`, callback_data: 'toggle_status' }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
                ]
            ]
        };

        await this.sendMessage(msg.chat.id, settingsMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleContacts(msg) {
        try {
            const contacts = await this.bridge.database.getAllContacts();
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

            await this.sendMessage(msg.chat.id, contactsMessage, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } catch (error) {
            logger.error('❌ Error handling contacts:', error);
            await this.sendMessage(msg.chat.id, '❌ Error loading contacts');
        }
    }

    async handleSendMessage(msg, match) {
        const parts = match[1].split(' ');
        const number = parts[0];
        const message = parts.slice(1).join(' ');

        if (!number || !message) {
            await this.sendMessage(msg.chat.id, '❓ Usage: /send <number> <message>');
            return;
        }

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            await this.sendMessage(msg.chat.id, `✅ Message sent to ${number}`);
        } catch (error) {
            logger.error('❌ Error sending message:', error);
            await this.sendMessage(msg.chat.id, `❌ Failed to send message: ${error.message}`);
        }
    }

    async handleSync(msg) {
        await this.sendMessage(msg.chat.id, '🔄 Syncing contacts and updating topics...');
        try {
            await this.bridge.syncAllContacts();
            await this.sendMessage(msg.chat.id, '✅ Sync completed successfully!');
        } catch (error) {
            logger.error('❌ Error syncing:', error);
            await this.sendMessage(msg.chat.id, `❌ Sync failed: ${error.message}`);
        }
    }

    async handleBridgeStatus(msg) {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        const statusMessage = `📊 *Bridge Status Report*\n\n` +
                             `🔗 Bridge: ${this.bridge.bridgeEnabled ? '✅ Active' : '❌ Inactive'}\n` +
                             `📱 WhatsApp: ${this.bridge.whatsappBot.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `🤖 Telegram: ${this.isPolling ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `📊 Database: ${this.bridge.database.isConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
                             `💬 Active Chats: ${this.bridge.chatMappings.size}\n` +
                             `👥 Cached Users: ${this.bridge.userMappings.size}\n` +
                             `⏱️ Uptime: ${hours}h ${minutes}m\n` +
                             `🔄 Last Sync: ${new Date().toLocaleString()}`;

        await this.sendMessage(msg.chat.id, statusMessage, {
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

        await this.sendMessage(msg.chat.id, helpMessage, {
            parse_mode: 'Markdown'
        });
    }

    async handleViewOnce(msg) {
        if (!msg.reply_to_message) {
            await this.sendMessage(msg.chat.id, '❓ Reply to a message to send as view-once');
            return;
        }
        await this.sendMessage(msg.chat.id, '🔒 View-once message feature coming soon!');
    }

    async handleCallback(query) {
        const data = query.data;
        try {
            switch (data) {
                case 'toggle_bridge':
                    this.bridge.bridgeEnabled = !this.bridge.bridgeEnabled;
                    await this.bridge.database.setSetting('bridge_enabled', this.bridge.bridgeEnabled);
                    await this.bot.answerCallbackQuery(query.id, {
                        text: `Bridge ${this.bridge.bridgeEnabled ? 'enabled' : 'disabled'}!`,
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
            this.bridge.settings[settingKey] = !this.bridge.settings[settingKey];
            await this.bridge.database.setSetting(setting, this.bridge.settings[settingKey]);
            await this.bot.answerCallbackQuery(query.id, {
                text: `${setting} ${this.bridge.settings[settingKey] ? 'enabled' : 'disabled'}!`,
                show_alert: false
            });
            await this.handleSettings(query.message);
        }
    }

    async createForumTopic(chatId, name, options) {
        try {
            return await this.bot.createForumTopic(chatId, name, options);
        } catch (error) {
            logger.error('❌ Failed to create forum topic:', error);
            throw error;
        }
    }

    async closeForumTopic(chatId, topicId) {
        try {
            return await this.bot.closeForumTopic(chatId, topicId);
        } catch (error) {
            logger.error('❌ Failed to close forum topic:', error);
            throw error;
        }
    }

    async sendMessage(chatId, text, options = {}) {
        try {
            return await this.bot.sendMessage(chatId, text, options);
        } catch (error) {
            logger.error('❌ Failed to send message:', error);
            throw error;
        }
    }

    async sendPhoto(chatId, photo, options = {}) {
        try {
            return await this.bot.sendPhoto(chatId, photo, options);
        } catch (error) {
            logger.error('❌ Failed to send photo:', error);
            throw error;
        }
    }

    async sendVideo(chatId, video, options = {}) {
        try {
            return await this.bot.sendVideo(chatId, video, options);
        } catch (error) {
            logger.error('❌ Failed to send video:', error);
            throw error;
        }
    }

    async sendAudio(chatId, audio, options = {}) {
        try {
            return await this.bot.sendAudio(chatId, audio, options);
        } catch (error) {
            logger.error('❌ Failed to send audio:', error);
            throw error;
        }
    }

    async sendDocument(chatId, document, options = {}) {
        try {
            return await this.bot.sendDocument(chatId, document, options);
        } catch (error) {
            logger.error('❌ Failed to send document:', error);
            throw error;
        }
    }

    async sendSticker(chatId, sticker, options = {}) {
        try {
            return await this.bot.sendSticker(chatId, sticker, options);
        } catch (error) {
            logger.error('❌ Failed to send sticker:', error);
            throw error;
        }
    }

    async getFile(fileId) {
        try {
            return await this.bot.getFile(fileId);
        } catch (error) {
            logger.error('❌ Failed to get file:', error);
            throw error;
        }
    }

    async stop() {
        try {
            if (this.isPolling) {
                await this.bot.stopPolling();
                this.isPolling = false;
                logger.info('✅ Telegram bot polling stopped');
            }
        } catch (error) {
            logger.error('❌ Failed to stop polling:', error);
        }
    }
}

module.exports = TelegramBridgeBot;
