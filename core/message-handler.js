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
                await this.processMessage(msg);
            } catch (error) {
                logger.error('Error processing message:', error);
            }
        }
    }

    async processMessage(msg) {
        // Handle status messages
        if (msg.key.remoteJid === 'status@broadcast') {
            return this.handleStatusMessage(msg);
        }

        // Extract text from message (including captions)
        const text = this.extractText(msg);
        
        // Check if it's a command (only for text messages, not media with captions)
        const prefix = config.get('bot.prefix');
        const isCommand = text && text.startsWith(prefix) && !this.hasMedia(msg);
        
        if (isCommand) {
            await this.handleCommand(msg, text);
        } else {
            // Handle non-command messages (including media)
            await this.handleNonCommandMessage(msg, text);
        }

        // FIXED: ALWAYS sync to Telegram if bridge is active (this was the main issue)
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    // New method to check if message has media
    hasMedia(msg) {
        return !!(
            msg.message?.imageMessage ||
            msg.message?.videoMessage ||
            msg.message?.audioMessage ||
            msg.message?.documentMessage ||
            msg.message?.stickerMessage ||
            msg.message?.locationMessage ||
            msg.message?.contactMessage
        );
    }

    async handleStatusMessage(msg) {
        if (config.get('features.autoViewStatus')) {
            try {
                await this.bot.sock.readMessages([msg.key]);
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(`❤️ Liked status from ${msg.key.participant}`);
            } catch (error) {
                logger.error('Error handling status:', error);
            }
        }
        
        // Also sync status messages to Telegram
        if (this.bot.telegramBridge) {
            const text = this.extractText(msg);
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    async handleCommand(msg, text) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const prefix = config.get('bot.prefix');
        
        // Extract command and arguments
        const args = text.slice(prefix.length).trim().split(/\s+/);
        const command = args[0].toLowerCase();
        const params = args.slice(1);

        // Check permissions
        if (!this.checkPermissions(msg, command)) {
            return this.bot.sendMessage(sender, {
                text: '❌ You don\'t have permission to use this command.'
            });
        }

        // Check rate limits
        const userId = participant.split('@')[0];
        if (config.get('features.rateLimiting')) {
            const canExecute = await rateLimiter.checkCommandLimit(userId);
            if (!canExecute) {
                const remainingTime = await rateLimiter.getRemainingTime(userId);
                return this.bot.sendMessage(sender, {
                    text: `⏱️ Rate limit exceeded. Try again in ${Math.ceil(remainingTime / 1000)} seconds.`
                });
            }
        }

        // Execute command
        const handler = this.commandHandlers.get(command);
        if (handler) {
            try {
                await handler.execute(msg, params, {
                    bot: this.bot,
                    sender,
                    participant,
                    isGroup: sender.endsWith('@g.us')
                });
                logger.info(`✅ Command executed: ${command} by ${participant}`);
                
                // Log command to Telegram
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📝 Command Executed', 
                        `Command: ${command}\nUser: ${participant}\nChat: ${sender}`);
                }
            } catch (error) {
                logger.error(`❌ Command failed: ${command}`, error);
                await this.bot.sendMessage(sender, {
                    text: `❌ Command failed: ${error.message}`
                });
                
                // Log error to Telegram
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('❌ Command Error', 
                        `Command: ${command}\nError: ${error.message}\nUser: ${participant}`);
                }
            }
        } else {
            await this.bot.sendMessage(sender, {
                text: `❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.`
            });
        }
    }

    async handleNonCommandMessage(msg, text) {
        // Log media messages for debugging
        if (this.hasMedia(msg)) {
            const mediaType = this.getMediaType(msg);
            logger.debug(`📎 Media message received: ${mediaType} from ${msg.key.participant || msg.key.remoteJid}`);
        } else if (text) {
            logger.debug('💬 Text message received:', text.substring(0, 50));
        }
    }

    getMediaType(msg) {
        if (msg.message?.imageMessage) return 'image';
        if (msg.message?.videoMessage) return 'video';
        if (msg.message?.audioMessage) return 'audio';
        if (msg.message?.documentMessage) return 'document';
        if (msg.message?.stickerMessage) return 'sticker';
        if (msg.message?.locationMessage) return 'location';
        if (msg.message?.contactMessage) return 'contact';
        return 'unknown';
    }

    checkPermissions(msg, command) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const owner = config.get('bot.owner');
        const mode = config.get('features.mode');
        
        // Check if user is owner
        const isOwner = participant === owner || msg.key.fromMe;
        
        // Check mode restrictions
        if (mode === 'private' && !isOwner) {
            return false;
        }

        // Check blocked users
        const blockedUsers = config.get('security.blockedUsers') || [];
        const userId = participant.split('@')[0];
        if (blockedUsers.includes(userId)) {
            return false;
        }

        return true;
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
}

module.exports = MessageHandler;
