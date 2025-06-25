/**
 * @file core/message-handler.js
 * @description Handles all incoming WhatsApp messages, parsing commands,
 * applying permissions and rate limits, and dispatching to appropriate handlers.
 */

const logger = require('./logger'); // For logging messages and errors
const config = require('../config'); // To access bot configuration (e.g., prefix, owner, features)
const rateLimiter = require('./rate-limiter'); // For managing command rate limits

/**
 * Manages the processing of incoming messages and dispatching of commands.
 */
class MessageHandler {
    /**
     * @param {object} bot - The main bot instance.
     * Provides access to other bot components like `sock` (WhatsApp socket),
     * `telegramBridge`, `moduleLoader`, and `config`.
     */
    constructor(bot) {
        this.bot = bot;
        /**
         * Stores registered command handlers.
         * Key: command name (lowercase string)
         * Value: The full command object as defined in modules (e.g., { name: 'menu', description: ..., execute: ... })
         * @type {Map<string, object>}
         */
        this.commandHandlers = new Map();
        logger.info('Message Handler initialized.');
    }

    /**
     * Registers a command handler with the MessageHandler.
     * This method is called by the ModuleLoader when loading modules.
     * @param {string} commandName - The actual name of the command (e.g., 'menu', 'weather').
     * @param {object} commandObject - The full command object, including `execute` function.
     */
    registerCommandHandler(commandName, commandObject) {
        // Store the command object, using its name (lowercase) as the map key
        this.commandHandlers.set(commandName.toLowerCase(), commandObject);
        logger.debug(`📝 Registered command handler: ${commandName}`);
    }

    /**
     * Retrieves all currently registered command objects.
     * This is used by modules like MenuModule to display dynamic command lists.
     * @returns {Map<string, object>} A Map where keys are command names (lowercase) and values are the full command objects.
     */
    getRegisteredCommands() {
        return this.commandHandlers;
    }

    /**
     * The main entry point for processing incoming WhatsApp messages.
     * This method is typically called by the bot's `sock.ev.on('messages.upsert')` listener.
     * @param {object} update - The update object from Baileys, containing `messages` and `type`.
     * @param {Array<object>} update.messages - An array of message objects.
     * @param {string} update.type - The type of message update (e.g., 'notify').
     */
    async handleMessages({ messages, type }) {
        logger.debug(`[MessageHandler] Received messages update. Type: "${type}", Message count: ${messages ? messages.length : 0}`);

        // Only process 'notify' type messages, which are new incoming messages
        if (type !== 'notify') {
            logger.debug(`[MessageHandler] Skipping message update of type: ${type}`);
            return;
        }

        // Iterate over each message in the update
        for (const msg of messages) {
            try {
                logger.debug(`[MessageHandler] Processing message ID: ${msg.key.id || 'N/A'}`);
                await this.processSingleMessage(msg);
            } catch (error) {
                logger.error(`[MessageHandler] Error processing message ID ${msg.key.id || 'N/A'}:`, error);
                // Optionally send an error message back to the user if critical
                // await this.bot.sendMessage(msg.key.remoteJid, { text: 'An internal error occurred while processing your message.' });
            }
        }
    }

    /**
     * Processes a single message object.
     * @param {object} msg - The message object from Baileys.
     */
    async processSingleMessage(msg) {
        // Ignore messages sent by the bot itself to prevent infinite loops
        if (msg.key.fromMe) {
            logger.debug(`[processSingleMessage] Ignoring self-sent message ID: ${msg.key.id}`);
            return;
        }

        // Handle status messages (stories)
        if (msg.key.remoteJid === 'status@broadcast') {
            logger.debug(`[processSingleMessage] Received status message from ${msg.key.participant}`);
            return this.handleStatusMessage(msg);
        }

        // Extract text content from various message types
        const text = this.extractText(msg);
        logger.debug(`[processSingleMessage] Extracted text: "${text ? text.substring(0, 50) : '[No Text]'}"`);

        if (!text) {
            logger.debug(`[processSingleMessage] No extractable text found for message ID: ${msg.key.id}`);
            return; // If no text, nothing to process as a command or non-command message
        }

        const prefix = config.get('bot.prefix'); // Get the configured command prefix (e.g., '.')
        logger.debug(`[processSingleMessage] Configured prefix: "${prefix}"`);
        
        // Check if the message starts with the configured prefix, indicating a command
        if (text.startsWith(prefix)) {
            logger.debug(`[processSingleMessage] Detected potential command. Text starts with prefix.`);
            await this.handleCommand(msg, text);
        } else {
            logger.debug(`[processSingleMessage] Not a command. Handling as non-command message.`);
            await this.handleNonCommandMessage(msg, text);
        }

        // If Telegram bridge is enabled and initialized, sync the message
        if (config.get('telegram.enabled') && this.bot.telegramBridge) {
            logger.debug(`[processSingleMessage] Syncing message ID ${msg.key.id} to Telegram.`);
            await this.bot.telegramBridge.syncMessage(msg, text).catch(err => {
                logger.error(`[processSingleMessage] Error syncing message to Telegram: ${err.message}`);
            });
        }
    }

    /**
     * Handles WhatsApp status messages (stories).
     * Automatically views and reacts to statuses if 'autoViewStatus' is enabled.
     * @param {object} msg - The status message object.
     */
    async handleStatusMessage(msg) {
        if (config.get('features.autoViewStatus')) {
            try {
                // Mark the status as read
                await this.bot.sock.readMessages([msg.key]);
                // Send a heart reaction to the status
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.info(`❤️ Auto-liked status from ${msg.key.participant}`);
            } catch (error) {
                logger.error(`Error handling status from ${msg.key.participant}:`, error);
            }
        }
    }

    /**
     * Parses and executes a command message.
     * Applies permissions and rate limiting before command execution.
     * @param {object} msg - The original message object.
     * @param {string} fullText - The full message text starting with the prefix.
     */
    async handleCommand(msg, fullText) {
        const sender = msg.key.remoteJid; // The JID of the chat
        const participant = msg.key.participant || sender; // The JID of the actual sender
        const prefix = config.get('bot.prefix');

        // Extract command name and parameters
        const args = fullText.slice(prefix.length).trim().split(/\s+/);
        const commandName = args[0] ? args[0].toLowerCase() : '';
        const params = args.slice(1);

        logger.debug(`[handleCommand] Extracted command: "${commandName}", Params: [${params.join(', ')}]`);

        // Retrieve the command handler object from the map
        const commandHandler = this.commandHandlers.get(commandName);

        // If no handler is found for the command name
        if (!commandHandler) {
            logger.warn(`[handleCommand] Unknown command received: "${commandName}" from ${participant}`);
            await this.bot.sendMessage(sender, {
                text: `❓ Unknown command: *${prefix}${commandName}*\nType *${prefix}menu* for available commands.`
            });
            return;
        }

        // --- Permissions Check ---
        if (!this.checkPermissions(msg, commandHandler)) {
            logger.warn(`[handleCommand] Permission denied for command "${commandName}" to ${participant}`);
            await this.bot.sendMessage(sender, {
                text: '❌ You don\'t have permission to use this command.'
            });
            return;
        }

        // --- Rate Limit Check (if enabled) ---
        const userId = participant.split('@')[0];
        if (config.get('features.rateLimiting')) {
            const canExecute = await rateLimiter.checkCommandLimit(userId);
            if (!canExecute) {
                const remainingTime = await rateLimiter.getRemainingTime(userId);
                logger.warn(`[handleCommand] Rate limit exceeded for ${userId} on command "${commandName}".`);
                await this.bot.sendMessage(sender, {
                    text: `⏱️ Rate limit exceeded. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`
                });
                return;
            }
        }

        // --- Command Execution ---
        const context = {
            bot: this.bot,           
            sender,                  
            participant,             
            isGroup: sender.endsWith('@g.us'), 
        };

        try {
            logger.info(`[handleCommand] Executing command: "${commandName}" by ${participant} in ${sender}`);
            await commandHandler.execute(msg, params, context);
            logger.info(`✅ Command executed successfully: "${commandName}" by ${participant}`);
            
            if (config.get('telegram.enabled') && this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram(
                    '📝 Command Executed', 
                    `Command: ${commandName}\nUser: ${participant}\nChat: ${sender}\nMessage: ${fullText.substring(0, 100)}`
                ).catch(err => logger.error(`[handleCommand] Telegram log failed for command execution: ${err.message}`));
            }
        } catch (error) {
            logger.error(`❌ Command "${commandName}" failed for ${participant} in ${sender}:`, error);
            await this.bot.sendMessage(sender, {
                text: `❌ Command *${commandName}* failed: ${error.message || 'An unexpected error occurred.'}`
            });
            
            if (config.get('telegram.enabled') && this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram(
                    '❌ Command Error', 
                    `Command: ${commandName}\nUser: ${participant}\nChat: ${sender}\nError: ${error.message || 'Unknown'}`
                ).catch(err => logger.error(`[handleCommand] Telegram log failed for command error: ${err.message}`));
            }
        }
    }

    /**
     * Handles messages that do not start with the command prefix.
     * @param {object} msg - The original message object.
     * @param {string} text - The message text.
     */
    async handleNonCommandMessage(msg, text) {
        // You can add logic here for AI responses, general chat,
        // or passing messages to other modules for processing
        logger.debug(`[handleNonCommandMessage] Received non-command: "${text.substring(0, 50)}"`);
    }

    /**
     * Checks if the sender has the necessary permissions to execute a given command.
     * @param {object} msg - The original message object.
     * @param {object} commandHandler - The full command handler object (contains 'permissions' property).
     * @returns {boolean} True if permission is granted, false otherwise.
     */
    checkPermissions(msg, commandHandler) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const owner = config.get('bot.owner');
        const mode = config.get('features.mode');
        
        const ownerNum = owner ? owner.split('@')[0] : null;
        const participantNum = participant.split('@')[0];

        const isOwner = (ownerNum && participantNum === ownerNum) || msg.key.fromMe;
        
        if (mode === 'private' && !isOwner) {
            logger.debug(`[checkPermissions] Permission denied: Bot in private mode and user (${participantNum}) is not owner.`);
            return false;
        }

        const blockedUsers = config.get('security.blockedUsers') || [];
        if (blockedUsers.includes(participantNum)) {
            logger.debug(`[checkPermissions] Permission denied: User (${participantNum}) is blocked.`);
            return false;
        }

        // Add more permission checks here as needed

        logger.debug(`[checkPermissions] Permission granted for ${participantNum}.`);
        return true;
    }

    /**
     * Extracts the primary text content from various types of message objects.
     * @param {object} msg - The message object from Baileys.
     * @returns {string} The extracted text content, or an empty string if no relevant text is found.
     */
    extractText(msg) {
        // Baileys message structures can be complex. Check for common text fields.
        if (msg.message) {
            if (msg.message.conversation) return msg.message.conversation;
            if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
            if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
            if (msg.message.videoMessage?.caption) return msg.message.videoMessage.caption;
            // Add other message types if needed, e.g., documentMessage.caption, pollCreationMessage.name
        }
        return '';
    }
}

module.exports = MessageHandler;
