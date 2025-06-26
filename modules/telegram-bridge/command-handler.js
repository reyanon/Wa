const logger = require('../../core/logger');

class CommandHandler {
    constructor(telegramBridge) {
        this.bridge = telegramBridge;
        this.commands = new Map();
        this.setupCommands();
    }

    setupCommands() {
        // Admin commands
        this.commands.set('/start', this.handleStart.bind(this));
        this.commands.set('/help', this.handleHelp.bind(this));
        this.commands.set('/status', this.handleStatus.bind(this));
        this.commands.set('/settings', this.handleSettings.bind(this));
        
        // Bridge control
        this.commands.set('/bridge', this.handleBridge.bind(this));
        this.commands.set('/target', this.handleTarget.bind(this));
        
        // Contact management
        this.commands.set('/contacts', this.handleContacts.bind(this));
        this.commands.set('/sync', this.handleSync.bind(this));
        
        // Message sending
        this.commands.set('/send', this.handleSend.bind(this));
        this.commands.set('/broadcast', this.handleBroadcast.bind(this));
        
        // Media settings
        this.commands.set('/media', this.handleMedia.bind(this));
        
        // Statistics
        this.commands.set('/stats', this.handleStats.bind(this));
        
        // Admin management
        this.commands.set('/admin', this.handleAdmin.bind(this));
        
        logger.info('📋 Command handlers registered');
    }

    async handleCommand(msg) {
        const command = msg.text.split(' ')[0].toLowerCase();
        
        if (!this.commands.has(command)) {
            return;
        }

        try {
            await this.commands.get(command)(msg);
        } catch (error) {
            logger.error(`Failed to handle command ${command}:`, error);
            await this.sendErrorMessage(msg.chat.id, 'Command execution failed');
        }
    }

    async handleStart(msg) {
        const welcomeMsg = `🤖 *Welcome to Advanced WhatsApp Bridge*\n\n` +
                          `🔥 This bot bridges WhatsApp messages to Telegram with advanced features!\n\n` +
                          `📋 Use /help to see all available commands\n` +
                          `⚙️ Use /settings to configure the bridge\n` +
                          `📊 Use /status to check current status\n\n` +
                          `🛡️ Admin Only: Contact the bot owner for access.`;

        await this.bridge.getTelegramBot().sendMessage(msg.chat.id, welcomeMsg, {
            parse_mode: 'Markdown'
        });
    }

    async handleHelp(msg) {
        const helpText = `📋 *Available Commands*\n\n` +
                        `🎛️ *Bridge Control:*\n` +
                        `/bridge on|off - Enable/disable bridge\n` +
                        `/target <chat_id> - Set target Telegram group\n` +
                        `/settings - Show bridge settings\n\n` +
                        `👥 *Contact Management:*\n` +
                        `/contacts - List all contacts\n` +
                        `/sync contacts - Sync WhatsApp contacts\n` +
                        `/sync pictures - Update profile pictures\n\n` +
                        `💬 *Messaging:*\n` +
                        `/send <number> <message> - Send message\n` +
                        `/broadcast <message> - Broadcast to all\n\n` +
                        `🎥 *Media Settings:*\n` +
                        `/media - Configure media types\n\n` +
                        `📊 *Information:*\n` +
                        `/status - Bridge status\n` +
                        `/stats - Usage statistics\n\n` +
                        `👑 *Admin:*\n` +
                        `/admin add|remove <user_id> - Manage admins`;

        await this.bridge.getTelegramBot().sendMessage(msg.chat.id, helpText, {
            parse_mode: 'Markdown'
        });
    }

    async handleStatus(msg) {
        const database = this.bridge.getDatabase();
        const stats = await database.getStats();
        const settings = await database.getSettings();
        
        const statusMsg = `📊 *Bridge Status*\n\n` +
                         `🔗 Bridge: ${this.bridge.isBridgeEnabled() ? '✅ Enabled' : '❌ Disabled'}\n` +
                         `📱 Target Chat: ${settings.targetChatId || '❌ Not Set'}\n` +
                         `👥 Admin Users: ${settings.adminUsers?.length || 0}\n` +
                         `💾 Database: ${await database.isHealthy() ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                         `📈 *Statistics:*\n` +
                         `👤 Contacts: ${stats.contacts || 0}\n` +
                         `💬 Active Chats: ${stats.activeChats || 0}\n` +
                         `📨 Total Messages: ${stats.totalMessages || 0}\n` +
                         `📱 Status Updates: ${stats.statusUpdates || 0}\n` +
                         `📞 Call Logs: ${stats.callLogs || 0}\n\n` +
                         `⏰ Last Update: ${new Date().toLocaleString()}`;

        await this.bridge.getTelegramBot().sendMessage(msg.chat.id, statusMsg, {
            parse_mode: 'Markdown'
        });
    }

    async handleSettings(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        await this.showSettings(msg.chat.id);
    }

    async showSettings(chatId, messageId = null) {
        const settings = await this.bridge.getDatabase().getSettings();
        
        const settingsText = `⚙️ *Bridge Settings*\n\n` +
                           `🔗 Bridge Status: ${this.bridge.isBridgeEnabled() ? '✅ Enabled' : '❌ Disabled'}\n` +
                           `📱 Target Chat: ${settings.targetChatId || 'Not Set'}\n` +
                           `👥 Admin Users: ${settings.adminUsers?.length || 0}\n\n` +
                           `🎥 *Media Settings:*\n` +
                           `📷 Images: ${settings.allowedMediaTypes?.image ? '✅' : '❌'}\n` +
                           `🎬 Videos: ${settings.allowedMediaTypes?.video ? '✅' : '❌'}\n` +
                           `🎵 Audio: ${settings.allowedMediaTypes?.audio ? '✅' : '❌'}\n` +
                           `📄 Documents: ${settings.allowedMediaTypes?.document ? '✅' : '❌'}\n` +
                           `🏷️ Stickers: ${settings.allowedMediaTypes?.sticker ? '✅' : '❌'}\n` +
                           `🎙️ Voice: ${settings.allowedMediaTypes?.voice ? '✅' : '❌'}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: this.bridge.isBridgeEnabled() ? '🔴 Disable Bridge' : '🟢 Enable Bridge', callback_data: 'settings_toggle-bridge' }
                ],
                [
                    { text: '🔄 Sync Contacts', callback_data: 'settings_sync-contacts' },
                    { text: '🖼️ Sync Pictures', callback_data: 'settings_sync-pictures' }
                ],
                [
                    { text: '🎥 Media Settings', callback_data: 'settings_media' }
                ]
            ]
        };

        if (messageId) {
            await this.bridge.getTelegramBot().editMessageText(settingsText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            await this.bridge.getTelegramBot().sendMessage(chatId, settingsText, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    async handleBridge(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        const args = msg.text.split(' ');
        if (args.length < 2) {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /bridge on|off');
            return;
        }

        const action = args[1].toLowerCase();
        if (action === 'on') {
            this.bridge.isEnabled = true;
            await this.bridge.saveSettings();
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '✅ Bridge enabled');
        } else if (action === 'off') {
            this.bridge.isEnabled = false;
            await this.bridge.saveSettings();
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '🔴 Bridge disabled');
        } else {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /bridge on|off');
        }
    }

    async handleTarget(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        const args = msg.text.split(' ');
        if (args.length < 2) {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /target <chat_id>');
            return;
        }

        const chatId = args[1];
        this.bridge.targetChatId = chatId;
        await this.bridge.saveSettings();
        
        await this.bridge.getTelegramBot().sendMessage(msg.chat.id, `✅ Target chat set to: ${chatId}`);
    }

    async handleContacts(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        const contacts = await this.bridge.getDatabase().getAllContacts();
        
        if (contacts.length === 0) {
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '📭 No contacts found');
            return;
        }

        let contactList = `👥 *Contacts (${contacts.length})*\n\n`;
        
        contacts.slice(0, 20).forEach((contact, index) => {
            const name = contact.name || contact.pushName || 'Unknown';
            const status = contact.isGroup ? '👥 Group' : '👤 Private';
            contactList += `${index + 1}. ${status} *${name}*\n`;
            contactList += `   📱 ${contact.phone}\n`;
            contactList += `   💬 ${contact.messageCount} messages\n`;
            contactList += `   📅 ${new Date(contact.lastActive).toLocaleDateString()}\n\n`;
        });

        if (contacts.length > 20) {
            contactList += `\n... and ${contacts.length - 20} more contacts`;
        }

        await this.bridge.getTelegramBot().sendMessage(msg.chat.id, contactList, {
            parse_mode: 'Markdown'
        });
    }

    async handleSync(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        const args = msg.text.split(' ');
        if (args.length < 2) {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /sync contacts|pictures');
            return;
        }

        const type = args[1].toLowerCase();
        
        if (type === 'contacts') {
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '🔄 Starting contact sync...');
            await this.bridge.contactManager.syncAllContacts();
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '✅ Contact sync completed');
        } else if (type === 'pictures') {
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '🔄 Starting profile picture sync...');
            await this.bridge.contactManager.syncProfilePictures();
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, '✅ Profile picture sync completed');
        } else {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /sync contacts|pictures');
        }
    }

    async handleSend(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        const args = msg.text.split(' ');
        if (args.length < 3) {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /send <number> <message>');
            return;
        }

        const number = args[1];
        const message = args.slice(2).join(' ');
        
        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.getWhatsAppBot().sendMessage(jid, { text: message });
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, `✅ Message sent to ${number}`);
        } catch (error) {
            await this.sendErrorMessage(msg.chat.id, `❌ Failed to send message: ${error.message}`);
        }
    }

    async handleMedia(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        await this.showMediaSettings(msg.chat.id);
    }

    async showMediaSettings(chatId, messageId = null) {
        const settings = await this.bridge.getDatabase().getSettings();
        const media = settings.allowedMediaTypes || {};
        
        const mediaText = `🎥 *Media Settings*\n\n` +
                         `Configure which media types are allowed:\n\n` +
                         `📷 Images: ${media.image ? '✅ Enabled' : '❌ Disabled'}\n` +
                         `🎬 Videos: ${media.video ? '✅ Enabled' : '❌ Disabled'}\n` +
                         `🎵 Audio: ${media.audio ? '✅ Enabled' : '❌ Disabled'}\n` +
                         `📄 Documents: ${media.document ? '✅ Enabled' : '❌ Disabled'}\n` +
                         `🏷️ Stickers: ${media.sticker ? '✅ Enabled' : '❌ Disabled'}\n` +
                         `🎙️ Voice: ${media.voice ? '✅ Enabled' : '❌ Disabled'}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `📷 ${media.image ? '✅' : '❌'}`, callback_data: `media_image-${!media.image}` },
                    { text: `🎬 ${media.video ? '✅' : '❌'}`, callback_data: `media_video-${!media.video}` }
                ],
                [
                    { text: `🎵 ${media.audio ? '✅' : '❌'}`, callback_data: `media_audio-${!media.audio}` },
                    { text: `📄 ${media.document ? '✅' : '❌'}`, callback_data: `media_document-${!media.document}` }
                ],
                [
                    { text: `🏷️ ${media.sticker ? '✅' : '❌'}`, callback_data: `media_sticker-${!media.sticker}` },
                    { text: `🎙️ ${media.voice ? '✅' : '❌'}`, callback_data: `media_voice-${!media.voice}` }
                ]
            ]
        };

        if (messageId) {
            await this.bridge.getTelegramBot().editMessageText(mediaText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            await this.bridge.getTelegramBot().sendMessage(chatId, mediaText, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    async handleStats(msg) {
        const stats = await this.bridge.getDatabase().getStats();
        
        const statsMsg = `📊 *Usage Statistics*\n\n` +
                        `👤 Total Contacts: ${stats.contacts || 0}\n` +
                        `💬 Active Chats: ${stats.activeChats || 0}\n` +
                        `📨 Messages Processed: ${stats.totalMessages || 0}\n` +
                        `📱 Status Updates: ${stats.statusUpdates || 0}\n` +
                        `📞 Call Logs: ${stats.callLogs || 0}\n\n` +
                        `⏰ Generated: ${new Date().toLocaleString()}`;

        await this.bridge.getTelegramBot().sendMessage(msg.chat.id, statsMsg, {
            parse_mode: 'Markdown'
        });
    }

    async handleAdmin(msg) {
        if (!this.bridge.isAdminUser(msg.from.id)) {
            await this.sendErrorMessage(msg.chat.id, '❌ Admin access required');
            return;
        }

        const args = msg.text.split(' ');
        if (args.length < 3) {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /admin add|remove <user_id>');
            return;
        }

        const action = args[1].toLowerCase();
        const userId = args[2];

        if (action === 'add') {
            this.bridge.adminUsers.add(userId);
            await this.bridge.saveSettings();
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, `✅ Added admin: ${userId}`);
        } else if (action === 'remove') {
            this.bridge.adminUsers.delete(userId);
            await this.bridge.saveSettings();
            await this.bridge.getTelegramBot().sendMessage(msg.chat.id, `✅ Removed admin: ${userId}`);
        } else {
            await this.sendErrorMessage(msg.chat.id, '❌ Usage: /admin add|remove <user_id>');
        }
    }

    async sendErrorMessage(chatId, message) {
        try {
            await this.bridge.getTelegramBot().sendMessage(chatId, message);
        } catch (error) {
            logger.error('Failed to send error message:', error);
        }
    }
}

module.exports = CommandHandler;
