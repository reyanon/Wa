const logger = require('./logger');
const config = require('../config');
const rateLimiter = require('./rate-limiter');

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.commandHandlers = new Map();
    }

    registerCommandHandler(command, handler) {
        this.commandHandlers.set(command.toLowerCase(), handler);
        logger.debug(`📝 Registered command handler: ${command}`);
    }

    async handleMessages({ messages, type }) {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message && !msg.messageStubType) continue;
                await this.processMessage(msg);
            } catch (error) {
                logger.error('❌ Error processing message:', error);
            }
        }
    }

    async processMessage(msg) {
        const text = this.extractText(msg);
        const sender = msg.key.remoteJid;

        // Handle status updates
        if (sender === 'status@broadcast') {
            await this.handleStatusMessage(msg, text);
            return;
        }

        // Handle profile picture updates
        if (msg.messageStubType === 5 && config.get('telegram.settings.autoUpdateProfilePics')) {
            await this.handleProfilePictureUpdate(msg);
        }

        // Handle command
        const prefix = config.get('bot.prefix');
        if (text && text.startsWith(prefix)) {
            await this.handleCommand(msg, text);
        } else {
            await this.handleNonCommandMessage(msg, text);
        }
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               '';
    }

    async handleCommand(msg, text) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const prefix = config.get('bot.prefix');
        
        const args = text.slice(prefix.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        if (!this.checkPermissions(msg, command)) {
            return this.bot.sendMessage(sender, {
                text: '❌ You don\'t have permission to use this command.'
            });
        }

        const userId = participant.split('@')[0];
        if (config.get('features.rateLimiting')) {
            const allowed = await rateLimiter.checkCommandLimit(userId);
            if (!allowed) {
                const time = await rateLimiter.getRemainingTime(userId);
                return this.bot.sendMessage(sender, {
                    text: `⏱️ Rate limit exceeded. Try again in ${Math.ceil(time / 1000)} seconds.`
                });
            }
        }

        const handler = this.commandHandlers.get(command);
        if (handler) {
            try {
                await handler.execute(msg, args, {
                    bot: this.bot,
                    sender,
                    participant,
                    isGroup: sender.endsWith('@g.us')
                });

                logger.info(`✅ Command executed: ${command} by ${participant}`);
            } catch (error) {
                logger.error(`❌ Command failed: ${command}`, error);
                await this.bot.sendMessage(sender, {
                    text: `❌ Command failed: ${error.message}`
                });
            }
        } else {
            await this.bot.sendMessage(sender, {
                text: `❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.`
            });
        }
    }

    async handleNonCommandMessage(msg, text) {
        logger.debug('📩 Non-command message received:', text ? text.substring(0, 50) : '[media]');
    }

    async handleStatusMessage(msg, text) {
        if (config.get('features.autoViewStatus')) {
            try {
                await this.bot.sock.readMessages([msg.key]);
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(`❤️ Liked status from ${msg.key.participant}`);
            } catch (error) {
                logger.error('❌ Error handling status:', error);
            }
        }
    }

    async handleProfilePictureUpdate(msg) {
        logger.debug('🖼️ Profile picture update detected');
        // You may implement further logic if needed (e.g., save locally, notify, etc.)
    }

    checkPermissions(msg, command) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const owner = config.get('bot.owner');
        const mode = config.get('features.mode');

        const isOwner = participant === owner || msg.key.fromMe;

        if (mode === 'private' && !isOwner) return false;

        const blockedUsers = config.get('security.blockedUsers') || [];
        const userId = participant.split('@')[0];
        if (blockedUsers.includes(userId)) return false;

        return true;
    }
}

module.exports = MessageHandler;
