const TelegramBot = require('node-telegram-bot-api'); // This import is not strictly needed here anymore, but keeping it for context
const config = require('../config');
const logger = require('./logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge; // The TelegramBridge instance
        this.bot = bridge.telegramBot;
        this.messageQueue = new Map(); // Stores messages for rate limiting
        this.commandRateLimits = new Map(); // Stores rate limit info for commands
        this.rateLimitDuration = config.get('features.rateLimiting.duration') || 5000; // Default 5 seconds
        this.rateLimitMessageCount = config.get('features.rateLimiting.messageCount') || 3; // Default 3 messages
        
        this.registerGlobalCommandHandlers();
        logger.info('⚙️ Telegram command handlers registered');
    }

    registerGlobalCommandHandlers() {
        this.bot.onText(/\/start/, this.wrapCommand(this.handleStart));
        this.bot.onText(/\/ping/, this.wrapCommand(this.handlePing));
        this.bot.onText(/\/status/, this.wrapCommand(this.handleStatus));
        this.bot.onText(/\/help/, this.wrapCommand(this.handleHelp));
        this.bot.onText(/\/restart/, this.wrapCommand(this.handleRestart));
        this.bot.onText(/\/setowner/, this.wrapCommand(this.handleSetOwner));
        this.bot.onText(/\/synccontacts/, this.wrapCommand(this.handleSyncContacts));
        this.bot.onText(/\/settargetchat (.+)/, this.wrapCommand(this.handleSetTargetChat)); 
        this.bot.onText(/\/send (.+) (.+)/, this.wrapCommand(this.handleSend)); // Matches /send <number> <message>
    }

    wrapCommand(handler) {
        return async (msg, match) => {
            const chatId = msg.chat.id;
            const command = match[0].split(' ')[0]; 

            // Rate limiting check
            if (config.get('features.rateLimiting')) {
                const now = Date.now();
                const userCommandKey = `${chatId}_${command}`;
                
                if (!this.commandRateLimits.has(userCommandKey)) {
                    this.commandRateLimits.set(userCommandKey, { count: 0, firstTimestamp: now });
                }

                const commandData = this.commandRateLimits.get(userCommandKey);

                // Clear old counts
                if (now - commandData.firstTimestamp > this.rateLimitDuration) {
                    commandData.count = 0;
                    commandData.firstTimestamp = now;
                }

                commandData.count++;

                if (commandData.count > this.rateLimitMessageCount) {
                    logger.warn(`⚠️ Rate limit exceeded for user ${chatId} on command ${command}`);
                    await this.bot.sendMessage(chatId, `⏳ Please wait a moment before sending too many commands.`);
                    return; 
                }
            }

            if (msg.chat.type === 'private') {
                this.bridge.botChatId = chatId;
            }

            try {
                await handler.call(this, msg, match);
            } catch (error) {
                logger.error(`❌ Error handling command ${command} for user ${chatId}:`, error);
                await this.bot.sendMessage(chatId, `❌ An error occurred while processing your command.`);
            }
        };
    }

    isOwner(chatId) {
        const ownerId = config.get('bot.owner');
        return ownerId && ownerId === chatId.toString();
    }

    async handleStart(msg) {
        const chatId = msg.chat.id;
        const welcomeMessage = `👋 Hello! I am *${config.get('bot.name')} v${config.get('bot.version')}*.\n\n` +
                               `I bridge messages between WhatsApp and Telegram.\n\n` +
                               `Type /help to see available commands.`;
        await this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    }

    async handlePing(msg) {
        const chatId = msg.chat.id;
        await this.bot.sendMessage(chatId, 'Pong!');
    }

    async handleStatus(msg) {
        const chatId = msg.chat.id;
        const waStatus = this.bridge.whatsappBot.sock?.user ? '✅ Connected' : '❌ Disconnected';
        const tgStatus = this.bridge.telegramBot ? '✅ Active' : '❌ Inactive';
        const bridgeStatus = this.bridge.bridgeActive ? '✅ Active' : '❌ Stopped'; 
        const ownerId = config.get('bot.owner') || 'Not set';
        const targetChatId = config.get('telegram.chatId') || 'Not set'; 
        
        const uptimeInSeconds = process.uptime();
        const hours = Math.floor(uptimeInSeconds / 3600);
        const minutes = Math.floor((uptimeInSeconds % 3600) / 60);
        const seconds = Math.floor(uptimeInSeconds % 60);

        let statusMessage = `*🤖 Bot Status:*\n\n` +
                            `• WhatsApp Connection: ${waStatus}\n` +
                            `• Telegram Bot: ${tgStatus}\n` +
                            `• Telegram Bridge: ${bridgeStatus}\n` + 
                            `• Owner ID: \`${ownerId}\`\n` +
                            `• Target Telegram Chat ID: \`${targetChatId}\`\n` + 
                            `• Synced WhatsApp Contacts: ${this.bridge.contactMappings.size}\n` +
                            `• Active WhatsApp Topics: ${this.bridge.chatMappings.size}\n` +
                            `• Uptime: ${hours}h ${minutes}m ${seconds}s\n\n` +
                            `_Version: ${config.get('bot.version')}_`;

        await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    }

    async handleHelp(msg) {
        const chatId = msg.chat.id;
        let helpMessage = `📚 *Available Commands:*\n\n`;

        const commands = [
            { cmd: '/start', desc: 'Get a welcome message' },
            { cmd: '/ping', desc: 'Check bot responsiveness' },
            { cmd: '/status', desc: 'Show bot connection status and uptime' },
            { cmd: '/help', desc: 'Show this command menu' },
            { cmd: '/send <number> <message>', desc: 'Send a message to a WhatsApp number' }
        ];

        if (this.isOwner(chatId)) {
            helpMessage += `\n👑 *Owner Commands:*\n`;
            commands.push(
                { cmd: '/restart', desc: 'Restart the bot (owner only)' },
                { cmd: '/setowner', desc: 'Set current user as owner (owner only)' },
                { cmd: '/synccontacts', desc: 'Sync WhatsApp contacts (owner only)' },
                { cmd: '/settargetchat <ID>', desc: 'Set the main Telegram chat ID for bridging (owner only)' } 
            );
        }

        commands.forEach(command => {
            helpMessage += `• ${command.cmd} - ${command.desc}\n`;
        });

        await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    async handleRestart(msg) {
        const chatId = msg.chat.id;
        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }
        await this.bot.sendMessage(chatId, '🔄 Restarting bot...');
        logger.info('🔄 Restart command received. Exiting for restart.');
        process.exit(0); 
    }

    async handleSetOwner(msg) {
        const chatId = msg.chat.id;
        if (config.get('bot.owner') && config.get('bot.owner') !== chatId.toString()) {
            await this.bot.sendMessage(chatId, '🚫 Bot owner is already set and you are not the current owner.');
            return;
        }
        config.set('bot.owner', chatId.toString());
        await config.save(); 
        await this.bot.sendMessage(chatId, `👑 You (${chatId}) have been set as the bot owner.`);
        logger.info(`👑 Bot owner set to: ${chatId}`);
    }

    async handleSetTargetChat(msg, match) {
        const chatId = msg.chat.id;
        const newTargetId = match[1].trim();

        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }

        if (!newTargetId || isNaN(parseInt(newTargetId))) { 
            await this.bot.sendMessage(chatId, '❓ Usage: /settargetchat <TelegramChatID>\nExample: /settargetchat -1001234567890');
            return;
        }

        const oldTargetId = config.get('telegram.chatId');
        
        try {
            config.set('telegram.chatId', newTargetId);
            await config.save(); 

            await this.bot.sendMessage(chatId, 
                `✅ Telegram target chat ID updated from \`${oldTargetId}\` to \`${newTargetId}\`.\n\n` +
                `*Please restart the bot for this change to take full effect in message bridging.*`
            );
            logger.info(`✅ Telegram target chat ID updated by owner: ${oldTargetId} -> ${newTargetId}`);
        } catch (error) {
            logger.error('❌ Failed to set target chat ID:', error);
            await this.bot.sendMessage(chatId, `❌ Failed to set target chat ID: ${error.message}`);
        }
    }

    async handleSyncContacts(msg) {
        const chatId = msg.chat.id;
        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }
        await this.bot.sendMessage(chatId, '🔄 Syncing WhatsApp contacts...');
        try {
            await this.bridge.syncContacts();
            await this.bot.sendMessage(chatId, '✅ WhatsApp contacts synced.');
            logger.info('✅ WhatsApp contacts synced by owner.');
        } catch (error) {
            logger.error('❌ Failed to sync contacts:', error);
            await this.bot.sendMessage(chatId, `❌ Failed to sync contacts: ${error.message}`);
        }
    }

    async handleSend(msg, match) {
        const chatId = msg.chat.id;
        const number = match[1];
        const message = match[2];
        
        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            const sendResult = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            
            if (sendResult?.key?.id) {
                await this.bot.sendMessage(chatId, `✅ Message sent to \`${number}\``);
            } else {
                await this.bot.sendMessage(chatId, `⚠️ Message may not have been delivered to \`${number}\``);
            }
        } catch (error) {
            logger.error(`❌ Failed to send message to ${number}:`, error);
            await this.bot.sendMessage(chatId, `❌ Failed to send message: ${error.message}`);
        }
    }
}

module.exports = TelegramCommands;
