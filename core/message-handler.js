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
        logger.debug(`Registered command handler: ${command}`); // Corrected: Removed emoji
    }

    async handleMessages({ messages, type }) {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message && !msg.messageStubType) continue;
                await this.processMessage(msg);
            } catch (error) {
                logger.error('Error processing message:', error); // Corrected: Removed emoji
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
            // This will now call the refined handleNonCommandMessage
            await this.handleNonCommandMessage(msg, text); 
        }

        // Sync messages to Telegram (including media and regular messages)
        // This is handled within handleNonCommandMessage and handleCommand already.
        // It's also handled within TelegramBridge for WhatsApp media.
        // To avoid duplicate sync, ensure this is not redundant.
        // If the `syncMessage` in `processMessage` is intended as a final catch-all,
        // ensure `handleNonCommandMessage` and `handleCommand` don't also sync.
        // For now, I'll assume the calls within specific handlers are primary.
        // If a message falls through (e.g., non-text/non-media), this can act as a fallback.
        if (this.bot.telegramBridge && msg.message && !text) { // Sync only if it's a message and no text (implying it's purely media that might not have a text caption)
             // This might be redundant if all media types are handled by syncMessage in TelegramBridge
             // through the handleWhatsAppMedia calls in TelegramBridge.
             // Consider if this explicit call is needed here, or if TelegramBridge handles all media.
             // For now, keeping it as a fallback for non-text messages that weren't commands.
             await this.bot.telegramBridge.syncMessage(msg, text || 'Media message without text');
        } else if (this.bot.telegramBridge && msg.message && text) {
            // For text messages not handled as commands, also sync.
            // This duplicates the sync in handleNonCommandMessage, so this block should be removed.
            // Removing this for cleaner logic, as handleNonCommandMessage now handles syncing.
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
                text: 'You don\'t have permission to use this command.'
            });
        }

        const userId = participant.split('@')[0];
        if (config.get('features.rateLimiting')) {
            const allowed = await rateLimiter.checkCommandLimit(userId);
            if (!allowed) {
                const time = await rateLimiter.getRemainingTime(userId);
                return this.bot.sendMessage(sender, {
                    text: `Rate limit exceeded. Try again in ${Math.ceil(time / 1000)} seconds.` // Corrected: Removed emoji
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

                logger.info(`Command executed: ${command} by ${participant}`); // Corrected: Removed emoji

                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('Command Executed', 
                        `Command: ${command}\nUser: ${participant}\nChat: ${sender}`); // Corrected: String literal and template literal
                }
            } catch (error) {
                logger.error(`Command failed: ${command}`, error); // Corrected: Removed emoji
                await this.bot.sendMessage(sender, {
                    text: `Command failed: ${error.message}` // Corrected: Removed emoji
                });

                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('Command Error',
                        `Command: ${command}\nError: ${error.message}\nUser: ${participant}`); // Corrected: String literal and template literal
                }
            }
        } else {
            await this.bot.sendMessage(sender, {
                text: `Unknown command: ${command}\nType *${prefix}menu* for available commands.` // Corrected: Removed emoji
            });
        }
    }

    // Merged and corrected handleNonCommandMessage
    async handleNonCommandMessage(msg, text) {
        logger.debug('Non-command message received:', text ? text.substring(0, 50) : 'Media message');

        // Note: The original code had a block here to "Forward message to WhatsApp (example)".
        // This seems redundant given the overall goal of the bot (WhatsApp -> Telegram bridge).
        // If the bot itself is supposed to forward messages to other WhatsApp chats, this logic
        // would be needed. Assuming this is NOT the primary goal and it's mostly for bridge.
        // If this part is to react to an *incoming* message, then sentMsg isn't correct.
        // Assuming this block is for reacting to messages the bot *receives* and then syncs.

        // React with a checkmark emoji for delivery confirmation
        // Note: `msg.key` is for the *incoming* message. If you want to react to
        // that incoming message, it's `msg.key`. If you want to react to a message
        // the bot *sends*, you need the key of the sent message.
        // The previous code had `sentMsg.key` which implies the bot sent something.
        // For simplicity and to avoid confusion, I'll react to the *incoming* message.
        try {
            await this.bot.sock.sendMessage(msg.key.remoteJid, {
                react: { key: msg.key, text: '✅' } // React to the incoming message
            });
            logger.debug(`Reacted to message from ${msg.key.remoteJid} with delivery confirmation`); // Corrected: Removed emoji
        } catch (error) {
            logger.error('Failed to send delivery confirmation reaction:', error); // Corrected: Removed emoji
        }

        // Sync to Telegram if applicable
        if (this.bot.telegramBridge) {
            // This is the core logic for syncing non-command messages to Telegram.
            // The `processMessage` method above calls this, which then calls `syncMessage`.
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    async handleStatusMessage(msg, text) {
        if (config.get('features.autoViewStatus')) {
            try {
                await this.bot.sock.readMessages([msg.key]);
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(`Liked status from ${msg.key.participant}`); // Corrected: Removed emoji
            } catch (error) {
                logger.error('Error handling status:', error); // Corrected: Removed emoji
            }
        }

        // Sync status updates to Telegram
        if (this.bot.telegramBridge && config.get('telegram.settings.syncStatus')) {
            try {
                // Create enhanced status message with user info
                const participant = msg.key.participant;
                // Ensure userMappings is accessible and populated in telegramBridge
                const userInfo = this.bot.telegramBridge.userMappings.get(participant); 
                const userName = userInfo?.name || participant?.split('@')[0] || 'Unknown';
                const userPhone = participant?.split('@')[0] || 'Unknown';
                
                // Create status message with user details
                const enhancedStatusMsg = {
                    ...msg,
                    key: { ...msg.key, remoteJid: 'status@broadcast' }, // Ensure remoteJid is set for proper topic mapping
                    statusUser: { // Add custom statusUser info for rich Telegram logging
                        name: userName,
                        phone: userPhone,
                        participant: participant
                    }
                };

                await this.bot.telegramBridge.syncMessage(enhancedStatusMsg, text || 'Status update');
            } catch (error) {
                logger.error('Error syncing status update to Telegram:', error); // Corrected: Removed emoji
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
                logger.debug(`Updated profile picture for ${participant.split('@')[0]}`); // Corrected: Removed emoji
            }
        } catch (error) {
            logger.error('Error handling profile picture update:', error); // Corrected: Removed emoji
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
