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
        logger.debug(📝 Registered command handler: ${command});
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

        // Sync messages to Telegram (including media and regular messages)
        if (this.bot.telegramBridge && msg.message) {
            await this.bot.telegramBridge.syncMessage(msg, text);
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
                    text: ⏱️ Rate limit exceeded. Try again in ${Math.ceil(time / 1000)} seconds.
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

                logger.info(✅ Command executed: ${command} by ${participant});

                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📝 Command Executed', 
                        Command: ${command}\nUser: ${participant}\nChat: ${sender});
                }
            } catch (error) {
                logger.error(❌ Command failed: ${command}, error);
                await this.bot.sendMessage(sender, {
                    text: ❌ Command failed: ${error.message}
                });

                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('❌ Command Error',
                        Command: ${command}\nError: ${error.message}\nUser: ${participant});
                }
            }
        } else {
            await this.bot.sendMessage(sender, {
                text: ❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.
            });
        }
    }

    async handleNonCommandMessage(msg, text) {
        logger.debug('Non-command message received:', text ? text.substring(0, 50) : 'Media message');
    }

    async handleStatusMessage(msg, text) {
        if (config.get('features.autoViewStatus')) {
            try {
                await this.bot.sock.readMessages([msg.key]);
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(❤️ Liked status from ${msg.key.participant});
            } catch (error) {
                logger.error('❌ Error handling status:', error);
            }
        }

async handleNonCommandMessage(msg, text) {
  logger.debug('Non-command message received:', text ? text.substring(0, 50) : 'Media message');

  // Forward message to WhatsApp (example)
  const sentMsg = await this.bot.sock.sendMessage(msg.key.remoteJid, { text });

  // React with a checkmark emoji for delivery confirmation
  try {
    await this.bot.sock.sendMessage(msg.key.remoteJid, {
      react: { key: sentMsg.key, text: '✅' }
    });
    logger.debug(`✅ Reacted to message from ${msg.key.remoteJid} with delivery confirmation`);
  } catch (error) {
    logger.error('❌ Failed to send delivery confirmation reaction:', error);
  }

  // Sync to Telegram if applicable
  if (this.bot.telegramBridge) {
    await this.bot.telegramBridge.syncMessage(sentMsg, text);
  }
}
        // Sync status updates to Telegram
        if (this.bot.telegramBridge && config.get('telegram.settings.syncStatus')) {
            try {
                // Create enhanced status message with user info
                const participant = msg.key.participant;
                const userInfo = this.bot.telegramBridge.userMappings.get(participant);
                const userName = userInfo?.name || participant?.split('@')[0] || 'Unknown';
                const userPhone = participant?.split('@')[0] || 'Unknown';
                
                // Create status message with user details
                const enhancedStatusMsg = {
                    ...msg,
                    key: { ...msg.key, remoteJid: 'status@broadcast' },
                    statusUser: {
                        name: userName,
                        phone: userPhone,
                        participant: participant
                    }
                };

                await this.bot.telegramBridge.syncMessage(enhancedStatusMsg, text || 'Status update');
            } catch (error) {
                logger.error('❌ Error syncing status update to Telegram:', error);
            }
        }
    }

    async handleProfilePictureUpdate(msg) {
        if (!this.bot.telegramBridge) return;

        try {
            const participant = msg.key.participant || msg.key.remoteJid;
            const topicId = this.bot.telegramBridge.chatMappings.get(participant);

            if (topicId) {
                await this.bot.telegramBridge.sendProfilePicture(topicId, participant, true);
                logger.debug(📸 Updated profile picture for ${participant.split('@')[0]});
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
