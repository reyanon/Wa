const config = require('../config');
const logger = require('./logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge; // The TelegramBridge instance
        this.bot = bridge.telegramBot;
        // The messageQueue and commandRateLimits are related to rate-limiting commands,
        // so they belong here.
        this.messageQueue = new Map(); 
        this.commandRateLimits = new Map(); 
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

        // Keep original commands from previous comands.js as requested
        this.bot.onText(/\/contacts/, this.wrapCommand(this.handleContacts));
        this.bot.onText(/\/sync/, this.wrapCommand(this.handleSync)); // Alias for /synccontacts
        this.bot.onText(/\/bridge (.+)/, this.wrapCommand(this.handleBridgeControl)); 
        this.bot.onText(/\/db (.+)/, this.wrapCommand(this.handleDbCommand)); // Retaining this as per original file
        this.bot.onText(/\/clearauth/, this.wrapCommand(this.handleClearAuth)); // Retaining clearauth
        this.bot.onText(/\/createtopic/, this.wrapCommand(this.handleCreateTopic)); // Retaining createtopic
        this.bot.onText(/\/deletetopic/, this.wrapCommand(this.handleDeleteTopic)); // Retaining deletetopic
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
                // Pass msg and match directly to handler
                await handler.call(this, msg, match); 
            } catch (error) {
                logger.error(`❌ Error handling command ${command} for user ${chatId}:`, error);
                await this.bot.sendMessage(chatId, `❌ An error occurred while processing your command.`);
            }
        };
    }

    isOwner(chatId) {
        const ownerId = config.get('bot.owner'); // This should be WA JID or Telegram ID
        // For Telegram commands, we primarily check against Telegram adminIds
        const telegramAdminIds = config.get('telegram.adminIds');
        return telegramAdminIds.includes(chatId);
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
                            `• Owner ID (WA): \`${ownerId}\`\n` +
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
            { cmd: '/send <number> <message>', desc: 'Send a message to a WhatsApp number' },
            { cmd: '/contacts', desc: 'List synced WhatsApp contacts' },
            { cmd: '/sync', desc: 'Manually sync WhatsApp contacts to the database' },
        ];

        if (this.isOwner(chatId)) {
            helpMessage += `\n👑 *Owner Commands:*\n`;
            commands.push(
                { cmd: '/restart', desc: 'Restart the bot (owner only)' },
                { cmd: '/setowner', desc: 'Set current user as owner (owner only)' }, // Now only sets Telegram owner ID
                { cmd: '/settargetchat <ID>', desc: 'Set the main Telegram chat ID for bridging (owner only)' },
                { cmd: '/bridge <start|stop|status>', desc: 'Control the bridge\'s operation (owner only)' },
                { cmd: '/db <save|load|clear>', desc: 'Perform database operations on mappings (owner only)' },
                { cmd: '/clearauth', desc: 'Clear WhatsApp authentication info (owner only)' },
                { cmd: '/createtopic <WA_JID> <Name>', desc: 'Manually create a Telegram topic for a WhatsApp JID (owner only)' },
                { cmd: '/deletetopic <WA_JID_or_TopicID>', desc: 'Delete a WhatsApp topic mapping (owner only)' }
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
        const newOwnerTelegramId = msg.from.id; // The user who sent the command

        // Only allow setting if no owner is configured, or if the current user is an existing admin
        const currentAdminIds = config.get('telegram.adminIds');
        if (currentAdminIds && currentAdminIds.length > 0 && !currentAdminIds.includes(newOwnerTelegramId)) {
            await this.bot.sendMessage(chatId, '🚫 Bot owner is already set and you are not an authorized admin.');
            return;
        }

        // Set the new owner's Telegram ID
        config.set('telegram.adminIds', [newOwnerTelegramId]); // Overwrite with new owner
        config.set('bot.owner', this.bridge.whatsappBot.sock?.user?.id || 'not_set@s.whatsapp.net'); // Keep WhatsApp owner JID if available
        
        await config.save(); 
        await this.bot.sendMessage(chatId, `👑 You (${newOwnerTelegramId}) have been set as the primary bot administrator.`);
        logger.info(`👑 Bot administrator set to: ${newOwnerTelegramId}`);
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

    // --- Original Commands (Re-added as requested) ---

    async handleContacts(msg) {
        const chatId = msg.chat.id;
        if (!this.isOwner(chatId)) { // Added owner check
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }

        if (this.bridge.contactMappings.size === 0) {
            await this.bot.sendMessage(chatId, 'No contacts synced yet. Use /sync to sync contacts.');
            return;
        }

        let contactList = '📚 *Synced WhatsApp Contacts:*\n\n';
        // Iterate through contactMappings (which are now `whatsappJid -> {name, number}` in bridge)
        this.bridge.contactMappings.forEach((contactData, jid) => {
            contactList += `• ${contactData.name || jid.split('@')[0]} (${contactData.number || jid.split('@')[0]})\n`;
        });

        await this.bot.sendMessage(chatId, contactList, { 
            parse_mode: 'Markdown' 
        });
    }

    async handleSync(msg) { // Alias for /synccontacts
        await this.handleSyncContacts(msg);
    }

    async handleBridgeControl(msg, match) {
        const chatId = msg.chat.id;
        const action = match[1].split(' ')[0].toLowerCase();

        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }

        switch (action) {
            case 'start':
                this.bridge.startBridge();
                await this.bot.sendMessage(chatId, '✅ Telegram bridge activated.');
                break;
            case 'stop':
                this.bridge.stopBridge();
                await this.bot.sendMessage(chatId, '🚫 Telegram bridge deactivated.');
                break;
            case 'status':
                await this.handleStatus(msg); // Reuse status handler
                break;
            default:
                await this.bot.sendMessage(chatId, 'Usage: /bridge <start|stop|status>');
        }
    }

    async handleDbCommand(msg, match) {
        const chatId = msg.chat.id;
        const action = match[1].split(' ')[0].toLowerCase();

        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }

        try {
            // DB operations are handled by the bridge
            switch (action) {
                case 'save':
                    // Trigger saving of current in-memory mappings to DB
                    // Note: Current save methods in bridge operate on single items.
                    // For a full "save all," you'd need batch operations or iterate maps.
                    // For simplicity, we'll just acknowledge the request. Real-time saving is handled by individual save calls.
                    await this.bot.sendMessage(chatId, '✅ In-memory mappings are periodically saved. Manual "save all" is not implemented as a single batch operation here.');
                    break;
                case 'load':
                    await this.bridge.loadMappingsFromDb();
                    await this.bot.sendMessage(chatId, `✅ Mappings reloaded from database. Loaded ${this.bridge.chatMappings.size} chats, ${this.bridge.userMappings.size} users, ${this.bridge.contactMappings.size} contacts.`);
                    break;
                case 'clear':
                    // Clear all mappings from DB and in-memory
                    await this.bridge.collections.chatMappings.deleteMany({});
                    await this.bridge.collections.userMappings.deleteMany({});
                    await this.bridge.collections.contactMappings.deleteMany({});
                    this.bridge.chatMappings.clear();
                    this.bridge.userMappings.clear();
                    this.bridge.contactMappings.clear();
                    await this.bot.sendMessage(chatId, '⚠️ All mappings cleared from database and memory.');
                    break;
                default:
                    await this.bot.sendMessage(chatId, `❌ Unknown database action: ${action}\nUse: save, load, or clear.`);
            }
        } catch (error) {
            logger.error(`❌ Error handling database command ${action}:`, error);
            await this.bot.sendMessage(chatId, `❌ Failed to execute database command: ${error.message}`);
        }
    }

    async handleClearAuth(msg) {
        const chatId = msg.chat.id;
        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }
        const authPath = './auth_info'; // This path is relative to the bot's root, not bridge
        try {
            await fs.remove(authPath);
            await this.bot.sendMessage(chatId, '🗑️ WhatsApp authentication info cleared. Please restart the bot and scan QR.');
            logger.info('🗑️ WhatsApp authentication info cleared by owner.');
            process.exit(0); 
        } catch (error) {
            logger.error('❌ Failed to clear auth info:', error);
            await this.bot.sendMessage(chatId, `❌ Failed to clear auth info: ${error.message}`);
        }
    }

    async handleCreateTopic(msg, match) {
        const chatId = msg.chat.id;
        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }
        const args = msg.text.split(' ').slice(1);
        if (args.length < 2) {
            await this.bot.sendMessage(chatId, '❓ Usage: /createtopic <WhatsAppJID> <TopicName>\nExample: /createtopic 1234567890@s.whatsapp.net MyFriend');
            return;
        }
        const whatsappJid = args[0];
        const topicName = args.slice(1).join(' '); 

        try {
            const topicId = await this.bridge.getOrCreateTopic(whatsappJid, { initialPushName: topicName }); // Use initialPushName
            if (topicId) {
                await this.bot.sendMessage(chatId, `✅ Topic "${topicName}" created/found for \`${whatsappJid}\` with ID: \`${topicId}\``);
                logger.info(`✅ Topic created/found by owner: ${topicName} for ${whatsappJid}`);
            } else {
                 await this.bot.sendMessage(chatId, `❌ Failed to create topic for \`${whatsappJid}\`. Check logs for details.`);
            }
        } catch (error) {
            logger.error('❌ Failed to create topic:', error);
            await this.bot.sendMessage(chatId, `❌ Failed to create topic: ${error.message}`);
        }
    }

    async handleDeleteTopic(msg, match) {
        const chatId = msg.chat.id;
        if (!this.isOwner(chatId)) {
            await this.bot.sendMessage(chatId, '🚫 You are not authorized to use this command.');
            return;
        }
        const args = msg.text.split(' ').slice(1);
        if (args.length === 0) {
            await this.bot.sendMessage(chatId, '❓ Usage: /deletetopic <WhatsAppJID_or_TopicID>');
            return;
        }
        const identifier = args[0]; 

        try {
            let deletedCount = 0;
            // Check if identifier is a JID
            if (identifier.includes('@s.whatsapp.net')) {
                const mapping = await this.bridge.collections.chatMappings.findOne({ whatsappJid: identifier });
                if (mapping) {
                    await this.bridge.collections.chatMappings.deleteOne({ whatsappJid: identifier });
                    deletedCount = 1;
                }
            } else { // Assume it's a Topic ID
                const topicId = parseInt(identifier);
                const mapping = await this.bridge.collections.chatMappings.findOne({ telegramTopicId: topicId });
                if (mapping) {
                    await this.bridge.collections.chatMappings.deleteOne({ telegramTopicId: topicId });
                    deletedCount = 1;
                }
            }
            
            if (deletedCount > 0) {
                await this.bridge.loadMappingsFromDb(); // Reload mappings after deletion to update in-memory cache
                await this.bot.sendMessage(chatId, `✅ Topic mapping for "${identifier}" deleted successfully.`);
                logger.info(`✅ Topic mapping deleted by owner: ${identifier}`);
            } else {
                await this.bot.sendMessage(chatId, `⚠️ Topic mapping for "${identifier}" not found.`);
            }
        } catch (error) {
            logger.error('❌ Failed to delete topic:', error);
            await this.bot.sendMessage(chatId, `❌ Failed to delete topic: ${error.message}`);
        }
    }
}

module.exports = TelegramCommands;
