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
         * Value: The full command object as defined in modules (e.g., { name, description, usage, category, execute })
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
        // Only process 'notify' type messages, which are new incoming messages
        if (type !== 'notify') {
            logger.debug(`Skipping message update of type: ${type}`);
            return;
        }

        // Iterate over each message in the update
        for (const msg of messages) {
            try {
                await this.processSingleMessage(msg);
            } catch (error) {
                logger.error(`Error processing message ID ${msg.key.id || 'N/A'}:`, error);
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
            logger.debug(`Ignoring self-sent message ID: ${msg.key.id}`);
            return;
        }

        // Handle status messages (stories)
        if (msg.key.remoteJid === 'status@broadcast') {
            logger.debug(`Received status message from ${msg.key.participant}`);
            return this.handleStatusMessage(msg);
        }

        // Extract text content from various message types
        const text = this.extractText(msg);
        if (!text) {
            logger.debug(`No extractable text in message ID: ${msg.key.id}`);
            return; // If no text, nothing to process as a command or non-command message
        }

        const prefix = config.get('bot.prefix'); // Get the configured command prefix (e.g., '.')
        
        // Check if the message starts with the configured prefix, indicating a command
        if (text.startsWith(prefix)) {
            logger.debug(`Potential command received: "${text}" from ${msg.key.remoteJid}`);
            await this.handleCommand(msg, text);
        } else {
            logger.debug(`Non-command message received: "${text.substring(0, 50)}..." from ${msg.key.remoteJid}`);
            await this.handleNonCommandMessage(msg, text);
        }

        // If Telegram bridge is enabled and initialized, sync the message
        if (config.get('telegram.enabled') && this.bot.telegramBridge) {
            logger.debug(`Syncing message ID ${msg.key.id} to Telegram.`);
            await this.bot.telegramBridge.syncMessage(msg, text).catch(err => {
                logger.error(`Error syncing message to Telegram: ${err.message}`);
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
                // Note: Reacting to statuses might require specific Baileys versions or WhatsApp features.
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
        const sender = msg.key.remoteJid; // The JID of the chat (e.g., '12345@s.whatsapp.net' for private, '12345@g.us' for group)
        const participant = msg.key.participant || sender; // The JID of the actual sender (important for groups)
        const prefix = config.get('bot.prefix');

        // Extract command name and parameters
        // Example: ".weather London, UK" -> ["weather", "London,", "UK"]
        const args = fullText.slice(prefix.length).trim().split(/\s+/);
        const commandName = args[0] ? args[0].toLowerCase() : ''; // Get command name, ensure it's lowercase
        const params = args.slice(1); // All subsequent parts are parameters

        logger.debug(`Attempting to handle command: "${commandName}" with params: [${params.join(', ')}] from ${participant}`);

        // Retrieve the command handler object from the map
        const commandHandler = this.commandHandlers.get(commandName);

        // If no handler is found for the command name
        if (!commandHandler) {
            logger.warn(`Unknown command received: "${commandName}" from ${participant}`);
            await this.bot.sendMessage(sender, {
                text: `❓ Unknown command: *${prefix}${commandName}*\nType *${prefix}menu* for available commands.`
            });
            return;
        }

        // --- Permissions Check ---
        // commandHandler.permissions can be defined in the module's command object
        // e.g., { name: 'kick', permissions: ['admin_group'], execute: ... }
        if (!this.checkPermissions(msg, commandHandler)) { // Pass the full commandHandler for more granular checks
            logger.warn(`Permission denied for command "${commandName}" to ${participant}`);
            await this.bot.sendMessage(sender, {
                text: '❌ You don\'t have permission to use this command.'
            });
            return;
        }

        // --- Rate Limit Check (if enabled) ---
        const userId = participant.split('@')[0]; // Use the numerical part of JID for rate limiting
        if (config.get('features.rateLimiting')) {
            const canExecute = await rateLimiter.checkCommandLimit(userId);
            if (!canExecute) {
                const remainingTime = await rateLimiter.getRemainingTime(userId);
                logger.warn(`Rate limit exceeded for ${userId} on command "${commandName}".`);
                await this.bot.sendMessage(sender, {
                    text: `⏱️ Rate limit exceeded. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`
                });
                return;
            }
        }

        // --- Command Execution ---
        // Create a context object to pass to the command's execute function
        const context = {
            bot: this.bot,           // Reference to the main bot instance
            sender,                  // The JID of the chat where the message originated
            participant,             // The JID of the user who sent the message
            isGroup: sender.endsWith('@g.us'), // Boolean indicating if the message is from a group
            // You can add more useful context here, e.g., msg.key, msg.message, etc.
        };

        try {
            logger.info(`Executing command: "${commandName}" by ${participant} in ${sender}`);
            // Call the execute function defined in the command handler object
            await commandHandler.execute(msg, params, context);
            logger.info(`✅ Command executed successfully: "${commandName}" by ${participant}`);
            
            // Log successful command execution to Telegram if bridge is active
            if (config.get('telegram.enabled') && this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram(
                    '📝 Command Executed', 
                    `Command: ${commandName}\nUser: ${participant}\nChat: ${sender}\nMessage: ${fullText.substring(0, 100)}`
                ).catch(err => logger.error(`Telegram log failed for command execution: ${err.message}`));
            }
        } catch (error) {
            // Handle errors during command execution
            logger.error(`❌ Command "${commandName}" failed for ${participant} in ${sender}:`, error);
            await this.bot.sendMessage(sender, {
                text: `❌ Command *${commandName}* failed: ${error.message || 'An unexpected error occurred.'}`
            });
            
            // Log command error to Telegram if bridge is active
            if (config.get('telegram.enabled') && this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram(
                    '❌ Command Error', 
                    `Command: ${commandName}\nUser: ${participant}\nChat: ${sender}\nError: ${error.message || 'Unknown'}`
                ).catch(err => logger.error(`Telegram log failed for command error: ${err.message}`));
            }
        }
    }

    /**
     * Handles messages that do not start with the command prefix.
     * This is a placeholder where you could integrate AI responses,
     * keyword triggers, or other passive functionalities.
     * @param {object} msg - The original message object.
     * @param {string} text - The message text.
     */
    async handleNonCommandMessage(msg, text) {
        // Example: You could pass this to an AI module's handler
        // if (this.bot.aiModule) {
        //     await this.bot.aiModule.processNonCommand(msg, text, { bot: this.bot, sender: msg.key.remoteJid });
        // }
    }

    /**
     * Checks if the sender has the necessary permissions to execute a given command.
     * This is a basic permission system; you can expand it with roles, specific command permissions, etc.
     * @param {object} msg - The original message object.
     * @param {object} commandHandler - The full command handler object (contains 'permissions' property).
     * @returns {boolean} True if permission is granted, false otherwise.
     */
    checkPermissions(msg, commandHandler) {
        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender; // Actual sender's JID
        const owner = config.get('bot.owner');
        const mode = config.get('features.mode');
        
        // Ensure the owner JID from config is used for comparison, remove the @s.whatsapp.net for consistency if comparing numbers
        const ownerNum = owner ? owner.split('@')[0] : null;
        const participantNum = participant.split('@')[0];

        // Check if the sender is the bot's owner
        const isOwner = (ownerNum && participantNum === ownerNum) || msg.key.fromMe;
        
        // --- Bot Mode Permissions ---
        // If bot is in 'private' mode, only the owner can use commands.
        if (mode === 'private' && !isOwner) {
            logger.debug(`Permission denied: Bot is in private mode and user (${participantNum}) is not owner.`);
            return false;
        }

        // --- Blocked Users Check ---
        const blockedUsers = config.get('security.blockedUsers') || [];
        if (blockedUsers.includes(participantNum)) {
            logger.debug(`Permission denied: User (${participantNum}) is blocked.`);
            return false;
        }

        // --- Command-Specific Permissions (if defined in the command object) ---
        // Example: a command object might have `permissions: ['admin_group']`
        // if (commandHandler.permissions && Array.isArray(commandHandler.permissions)) {
        //     if (commandHandler.permissions.includes('admin_group') && !msg.isGroupAdmin) { // requires bot to know if sender is admin
        //         return false;
        //     }
        //     // Add more specific permission checks here
        // }

        return true; // If no restrictions apply, permission is granted
    }

    /**
     * Extracts the primary text content from various types of WhatsApp message objects.
     * @param {object} msg - The message object from Baileys.
     * @returns {string} The extracted text content, or an empty string if no relevant text is found.
     */
    extractText(msg) {
        return msg.message?.conversation ||                // Standard text message
               msg.message?.extendedTextMessage?.text ||   // Extended text messages (e.g., replies, mentions)
               msg.message?.imageMessage?.caption ||       // Caption for image messages
               msg.message?.videoMessage?.caption ||       // Caption for video messages
               '';                                         // Default to empty string if no text found
    }
}

module.exports = MessageHandler;
