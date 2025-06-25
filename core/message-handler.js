const logger = require('./logger');
const config = require('../config');
const rateLimiter = require('./rate-limiter');

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        // This Map correctly stores { 'commandName': { name: 'commandName', description: ..., execute: ..., category: ... } }
        this.commandHandlers = new Map(); 
    }

    /**
     * Registers a command handler.
     * The `command` parameter here is the command name (string), and `handler` is the full command object.
     * @param {string} command - The name of the command (e.g., 'menu').
     * @param {object} handler - The full command object (e.g., { name: 'menu', description: '...', execute: ..., category: '...' }).
     */
    registerCommandHandler(command, handler) {
        this.commandHandlers.set(command.toLowerCase(), handler);
        logger.debug(`📝 Registered command handler: ${command}`);
    }

    /**
     * Retrieves all registered command objects.
     * This method is crucial for the MenuModule to dynamically list commands.
     * @returns {Map<string, object>} A Map where keys are command names (lowercase) and values are the full command objects.
     */
    getRegisteredCommands() {
        return this.commandHandlers;
    }

    /**
     * Handles incoming message updates from Baileys.
     * @param {object} param0 - Object containing messages array and type.
     * @param {Array<object>} param0.messages - Array of message objects.
     * @param {string} param0.type - Type of update (e.g., 'notify').
     */
    async handleMessages({ messages, type }) {
        if (type !== 'notify') return; // Only process 'notify' messages (incoming messages)

        for (const msg of messages) {
            try {
                await this.processMessage(msg);
            } catch (error) {
                logger.error('Error processing message:', error);
            }
        }
    }

    /**
     * Processes a single incoming message.
     * @param {object} msg - The message object from Baileys.
     */
    async processMessage(msg) {
        // Ignore messages sent by the bot itself to prevent loops
        if (msg.key.fromMe) return; 

        // Handle status messages (stories)
        if (msg.key.remoteJid === 'status@broadcast') {
            return this.handleStatusMessage(msg);
        }

        // Extract text from various message types (conversation, extended text, image/video caption)
        const text = this.extractText(msg);
        if (!text) return; // If no extractable text, do nothing

        const prefix = config.get('bot.prefix');
        if (text.startsWith(prefix)) {
            // It's a command, handle it
            await this.handleCommand(msg, text);
        } else {
            // It's not a command, pass it to other handlers if any (e.g., AI responses)
            await this.handleNonCommandMessage(msg, text);
        }

        // Sync to Telegram if bridge is active and enabled in config
        if (config.get('telegram.enabled') && this.bot.telegramBridge) {
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    /**
     * Handles WhatsApp status messages.
     * @param {object} msg - The status message object.
     */
    async handleStatusMessage(msg) {
        // If autoViewStatus feature is enabled
        if (config.get('features.autoViewStatus')) {
            try {
                // Mark the status as read
                await this.bot.sock.readMessages([msg.key]);
                // Send a heart reaction to the status
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(`❤️ Liked status from ${msg.key.participant}`);
            } catch (error) {
                logger.error('Error handling status:', error);
            }
        }
    }

    /**
     * Handles command messages.
     * @param {object} msg - The message object.
     * @param {string} text - The message text.
     */
    async handleCommand(msg, text) {
        const sender = msg.key.remoteJid; // The JID of the chat (group or private)
        const participant = msg.key.participant || sender; // The JID of the actual sender
        const prefix = config.get('bot.prefix');
        
        // Split text into command and parameters
        const args = text.slice(prefix.length).trim().split(/\s+/);
        const commandName = args[0].toLowerCase(); // The command name (e.g., 'menu')
        const params = args.slice(1); // Array of parameters

        // Check if the command exists
        const handler = this.commandHandlers.get(commandName);

        if (!handler) {
            // Command not found
            await this.bot.sendMessage(sender, {
                text: `❓ Unknown command: ${commandName}\nType *${prefix}menu* for available commands.`
            });
            return;
        }

        // Check permissions before executing
        if (!this.checkPermissions(msg, commandName)) { // Pass commandName for specific checks if needed
            return this.bot.sendMessage(sender, {
                text: '❌ You don\'t have permission to use this command.'
            });
        }

        // Check rate limits if enabled
        const userId = participant.split('@')[0]; // Extract phone number for rate limiting
        if (config.get('features.rateLimiting')) {
            const canExecute = await rateLimiter.checkCommandLimit(userId);
            if (!canExecute) {
                const remainingTime = await rateLimiter.getRemainingTime(userId);
                return this.bot.sendMessage(sender, {
                    text: `⏱️ Rate limit exceeded. Try again in ${Math.ceil(remainingTime / 1000)} seconds.`
                });
            }
        }

        // Construct context object for the command's execute function
        const context = {
            bot: this.bot,           // Reference to the main bot instance
            sender,                  // JID of the chat
            participant,             // JID of the message sender
            isGroup: sender.endsWith('@g.us'), // True if message is from a group
            // Add other useful context properties here (e.g., quoted message info)
        };

        // Execute the command handler
        try {
            await handler.execute(msg, params, context);
            logger.info(`✅ Command executed: ${commandName} by ${participant}`);
            
            // Log command execution to Telegram if bridge is active
            if (config.get('telegram.enabled') && this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('📝 Command Executed', 
                    `Command: ${commandName}\nUser: ${participant}\nChat: ${sender}`);
            }
        } catch (error) {
            logger.error(`❌ Command failed: ${commandName}`, error);
            await this.bot.sendMessage(sender, {
                text: `❌ Command failed: ${error.message}`
            });
            
            // Log command error to Telegram if bridge is active
            if (config.get('telegram.enabled') && this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('❌ Command Error', 
                    `Command: ${commandName}\nError: ${error.message}\nUser: ${participant}`);
            }
        }
    }

    /**
     * Handles non-command messages.
     * This is a placeholder for future AI responses, event triggers, etc.
     * @param {object} msg - The message object.
     * @param {string} text - The message text.
     */
    async handleNonCommandMessage(msg, text) {
        // You can add logic here for AI responses, general chat,
        // or passing messages to other modules for processing
        logger.debug('Non-command message received:', text.substring(0, 50));
    }

    /**
     * Checks if the sender has permission to use a command.
     * @param {object} msg - The message object.
     * @param {string} command - The command name.
     * @returns {boolean} True if permission is granted, false otherwise.
     */
    checkPermissions(msg, command) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender; // Actual sender for group messages
        const owner = config.get('bot.owner');
        const mode = config.get('features.mode');
        
        // Check if user is the bot's owner
        // Note: owner in config should be in JID format '923298784489@s.whatsapp.net'
        const isOwner = participant === owner; 
        
        // If bot is in private mode, only owner can use commands
        if (mode === 'private' && !isOwner) {
            return false;
        }

        // Check if user is blocked
        const blockedUsers = config.get('security.blockedUsers') || [];
        const userId = participant.split('@')[0]; // Get the phone number part
        if (blockedUsers.includes(userId)) {
            return false;
        }

        // Add more permission checks here as needed (e.g., group admin, specific command permissions)

        return true; // Default to true if no restrictions apply
    }

    /**
     * Extracts text content from various types of message objects.
     * @param {object} msg - The message object.
     * @returns {string} The extracted text, or an empty string if none found.
     */
    extractText(msg) {
        return msg.message?.conversation || 
               msg.message?.extendedTextMessage?.text || 
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption || 
               '';
    }
}

module.exports = MessageHandler;
