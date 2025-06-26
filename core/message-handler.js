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
                if (!msg.message) continue;
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

        // Handle call messages
        if (msg.messageStubType && this.isCallMessage(msg) && config.get('telegram.settings.syncCalls')) {
            await this.handleCallMessage(msg);
        }

        // Handle command
        const prefix = config.get('bot.prefix');
        if (text && text.startsWith(prefix)) {
            await this.handleCommand(msg, text);
        } else {
            await this.handleNonCommandMessage(msg, text);
        }

        // Sync non-command messages to Telegram
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
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

                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📝 Command Executed', 
                        `Command: ${command}\nUser: ${participant}\nChat: ${sender}`);
                }
            } catch (error) {
                logger.error(`❌ Command failed: ${command}`, error);
                await this.bot.sendMessage(sender, {
                    text: `❌ Command failed: ${error.message}`
                });

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
        logger.debug('Non-command message received:', text.substring(0, 50));
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

        if (this.bot.telegramBridge && config.get('telegram.settings.syncStatus')) {
            const statusMessage = {
                ...msg,
                key: { ...msg.key, remoteJid: 'status@broadcast' }
            };

            try {
                await this.bot.telegramBridge.syncMessage(statusMessage, text || 'Status update');
            } catch (error) {
                logger.error('❌ Error syncing status update to Telegram:', error);
            }
        }
    }

    async handleCallMessage(msg) {
        if (!this.bot.telegramBridge) return;

        const callType = this.getCallType(msg.messageStubType);
        const participant = msg.key.participant || msg.key.remoteJid;

        const callMessage = {
            ...msg,
            key: { ...msg.key, remoteJid: 'call@broadcast' }
        };

        try {
            await this.bot.telegramBridge.syncMessage(callMessage, `${callType} call from ${participant.split('@')[0]}`);
        } catch (error) {
            logger.error('❌ Error handling call message:', error);
        }
    }

    isCallMessage(msg) {
        const callTypes = [1, 2, 3, 4, 5];
        return callTypes.includes(msg.messageStubType);
    }

    getCallType(stubType) {
        switch (stubType) {
            case 1: return 'Missed';
            case 2: return 'Outgoing';
            case 3: return 'Incoming';
            case 4: return 'Video';
            default: return 'Unknown';
        }
    }

    async handleProfilePictureUpdate(msg) {
        if (!this.bot.telegramBridge) return;

        try {
            const participant = msg.key.participant || msg.key.remoteJid;
            const topicId = this.bot.telegramBridge.chatMappings.get(participant);

            if (topicId) {
                await this.bot.telegramBridge.sendProfilePicture(topicId, participant, true);
            }
        } catch (error) {
            logger.error('❌ Error handling profile picture update:', error);
        }
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
