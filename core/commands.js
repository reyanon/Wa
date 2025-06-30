const logger = require('./logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.split(' ');

        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;

                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;

                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;

                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;

                default:
                    await this.handleMenu(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(
                msg.chat.id,
                `❌ Command error: ${error.message}`
            );
        }
    }

    async handleStart(chatId) {
        const isReady = !!this.bridge.telegramBot;
        const welcome = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${isReady ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings.size}\n` +
            `Contacts: ${this.bridge.contactMappings.size}\n` +
            `Users: ${this.bridge.userMappings.size}`;

        await this.bridge.telegramBot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${this.bridge.whatsappBot?.sock?.user?.name || 'Unknown'}\n` +
            `💬 Chats: ${this.bridge.chatMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}`;

        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\nExample: /send 1234567890 Hello!');
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });

            if (result?.key?.id) {
                await this.bridge.telegramBot.sendMessage(chatId, `✅ Message sent to ${number}`);
            } else {
                await this.bridge.telegramBot.sendMessage(chatId, `⚠️ Message sent but no confirmation.`);
            }
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error sending: ${error.message}`);
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...');
        try {
            await this.bridge.syncContacts();
            await this.bridge.saveMappingsToDb();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Synced ${this.bridge.contactMappings.size} contacts from WhatsApp.`);
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to sync: ${error.message}`);
        }
    }

    async handleMenu(chatId) {
        const message = `ℹ️ Available commands:\n\n` +
            `/start - Start and show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/contacts - View WhatsApp contacts\n` +
            `/searchcontact - Search WhatsApp contacts`;
        await this.bridge.telegramBot.sendMessage(chatId, message);
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Start and show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'contacts', description: 'View WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' }
            ]);
        } catch (err) {
            logger.error("❌ Failed to register bot commands:", err);
        }
    }
}

module.exports = TelegramCommands;
