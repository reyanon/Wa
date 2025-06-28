const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('../config');
const logger = require('../core/logger');

// Set ffmpeg path if available
if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

class TelegramBridge {
    constructor(bot) {
        this.bot = bot;
        this.name = 'telegram-bridge';
        this.version = '1.12.1';
        this.description = 'Complete Telegram Bridge for WhatsApp Bot - All WatgBridge Features';
        
        // Core properties
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.messagePairs = new Map(); // WhatsApp Message ID -> Telegram Message ID
        this.userMappings = new Map(); // WhatsApp User -> Contact Info
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map();
        this.statusMessageIds = new Map();
        this.ephemeralSettings = new Map(); // Chat -> ephemeral settings
        this.unreadMessages = new Map(); // Chat -> unread message IDs
        
        // Configuration
        this.config = {
            botToken: config.get('telegram.botToken'),
            chatId: config.get('telegram.chatId'),
            logChannel: config.get('telegram.logChannel'),
            enabled: config.get('telegram.enabled', false),
            ownerIds: config.get('telegram.ownerIds', []),
            sudoUsers: config.get('telegram.sudoUsers', []),
            skipVideoStickers: config.get('telegram.skipVideoStickers', false),
            sendPresence: config.get('telegram.sendPresence', true),
            sendReadReceipts: config.get('telegram.sendReadReceipts', true),
            silentConfirmation: config.get('telegram.silentConfirmation', false),
            confirmationType: config.get('telegram.confirmationType', 'emoji'), // emoji, text, none
            spoilerViewOnce: config.get('telegram.spoilerViewOnce', true),
            reactions: config.get('telegram.reactions', true),
            skipStartupMessage: config.get('telegram.skipStartupMessage', false)
        };

        // Commands - Complete set from WatgBridge
        this.commands = [
            {
                name: 'tgstart',
                description: 'Show Telegram bridge status and uptime',
                usage: 'tgstart',
                execute: this.handleStartCommand.bind(this)
            },
            {
                name: 'tggroups',
                description: 'Get all WhatsApp groups with their JIDs',
                usage: 'tggroups',
                execute: this.handleGetGroupsCommand.bind(this)
            },
            {
                name: 'tgfind',
                description: 'Fuzzy find contact JIDs from names',
                usage: 'tgfind <search_string>',
                execute: this.handleFindContactCommand.bind(this)
            },
            {
                name: 'tgrevoke',
                description: 'Revoke a message from WhatsApp',
                usage: 'tgrevoke (reply to message)',
                execute: this.handleRevokeCommand.bind(this)
            },
            {
                name: 'tgsync',
                description: 'Sync contacts list from WhatsApp',
                usage: 'tgsync',
                execute: this.handleSyncContactsCommand.bind(this)
            },
            {
                name: 'tgclear',
                description: 'Delete all stored message ID pairs',
                usage: 'tgclear',
                execute: this.handleClearHistoryCommand.bind(this)
            },
            {
                name: 'tgrestart',
                description: 'Restart WhatsApp connection',
                usage: 'tgrestart',
                execute: this.handleRestartWACommand.bind(this)
            },
            {
                name: 'tgjoin',
                description: 'Join WhatsApp group using invite link',
                usage: 'tgjoin <invite_link>',
                execute: this.handleJoinGroupCommand.bind(this)
            },
            {
                name: 'tgsetgroup',
                description: 'Set target WhatsApp group for current thread',
                usage: 'tgsetgroup <group_id>',
                execute: this.handleSetTargetGroupCommand.bind(this)
            },
            {
                name: 'tgsetprivate',
                description: 'Set target WhatsApp private chat for current thread',
                usage: 'tgsetprivate <user_id>',
                execute: this.handleSetTargetPrivateCommand.bind(this)
            },
            {
                name: 'tgunlink',
                description: 'Unlink current thread from WhatsApp chat',
                usage: 'tgunlink',
                execute: this.handleUnlinkThreadCommand.bind(this)
            },
            {
                name: 'tgpic',
                description: 'Get profile picture of user or group',
                usage: 'tgpic <user/group_id>',
                execute: this.handleGetProfilePictureCommand.bind(this)
            },
            {
                name: 'tgtopics',
                description: 'Update names of created topics',
                usage: 'tgtopics',
                execute: this.handleSyncTopicNamesCommand.bind(this)
            },
            {
                name: 'tgsend',
                description: 'Send message to WhatsApp',
                usage: 'tgsend <target_id> (reply to message)',
                execute: this.handleSendCommand.bind(this)
            },
            {
                name: 'tghelp',
                description: 'Get all available Telegram bridge commands',
                usage: 'tghelp',
                execute: this.handleHelpCommand.bind(this)
            },
            {
                name: 'tgblock',
                description: 'Block a user in WhatsApp',
                usage: 'tgblock (in topic)',
                execute: this.handleBlockCommand.bind(this)
            },
            {
                name: 'tgunblock',
                description: 'Unblock a user in WhatsApp',
                usage: 'tgunblock (in topic)',
                execute: this.handleUnblockCommand.bind(this)
            },
            {
                name: 'tgbridge',
                description: 'Manage Telegram bridge settings',
                usage: 'tgbridge <start|stop|status|config>',
                execute: this.handleTgBridgeCommand.bind(this)
            }
        ];

        // Message hooks - Complete set from WatgBridge
        this.messageHooks = {
            'whatsapp_connected': this.onWhatsAppConnected.bind(this),
            'message_received': this.onMessageReceived.bind(this),
            'status_received': this.onStatusReceived.bind(this),
            'call_received': this.onCallReceived.bind(this),
            'group_participants_update': this.onGroupParticipantsUpdate.bind(this),
            'group_update': this.onGroupUpdate.bind(this),
            'presence_update': this.onPresenceUpdate.bind(this),
            'message_revoked': this.onMessageRevoked.bind(this),
            'message_reaction': this.onMessageReaction.bind(this)
        };

        this.startTime = new Date();
        this.stats = {
            messagesForwarded: 0,
            mediaForwarded: 0,
            commandsExecuted: 0,
            topicsCreated: 0,
            callsLogged: 0,
            reactionsHandled: 0,
            errors: 0
        };
    }

    async init() {
        logger.info('🔧 Initializing Complete Telegram Bridge module...');
        
        await fs.ensureDir(this.tempDir);
        
        if (this.config.enabled && this.isProperlyConfigured()) {
            await this.initializeTelegramBot();
        } else {
            logger.warn('⚠️ Telegram bridge not started - check configuration');
        }
        
        logger.info('✅ Complete Telegram Bridge module initialized');
    }

    async initializeTelegramBot() {
        if (!this.isProperlyConfigured()) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly');
            return false;
        }

        try {
            this.telegramBot = new TelegramBot(this.config.botToken, { 
                polling: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    }
                }
            });
            
            await this.setupTelegramHandlers();
            await this.registerBotCommands();
            
            if (!this.config.skipStartupMessage) {
                await this.sendStartupMessage();
            }
            
            logger.info('✅ Telegram bridge started successfully');
            return true;
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
            return false;
        }
    }

    async setupTelegramHandlers() {
        // Handle all message types
        this.telegramBot.on('message', async (msg) => {
            if (this.shouldProcessTelegramMessage(msg)) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle callback queries (for revoke buttons, etc.)
        this.telegramBot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    async registerBotCommands() {
        try {
            const botCommands = this.commands
                .filter(cmd => cmd.description && !['tgbridge'].includes(cmd.name))
                .map(cmd => ({
                    command: cmd.name,
                    description: cmd.description
                }));

            await this.telegramBot.setMyCommands(botCommands);
            logger.info(`📋 Registered ${botCommands.length} bot commands`);
        } catch (error) {
            logger.error('❌ Failed to register bot commands:', error);
        }
    }

    shouldProcessTelegramMessage(msg) {
        // Process messages in the configured supergroup with topics
        return msg.chat.type === 'supergroup' && 
               msg.chat.id.toString() === this.config.chatId.toString();
    }

    // Command Handlers - Complete implementation from WatgBridge
    async handleStartCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        const uptime = this.getUptime();
        const mappings = this.chatMappings.size;
        const users = this.userMappings.size;

        const statusText = 
            `🤖 *Telegram Bridge Status*\n\n` +
            `• *Up Since*: ${this.startTime.toLocaleString()} [ ${uptime} ]\n` +
            `• *Version*: \`${this.version}\`\n` +
            `• *Chat Mappings*: ${mappings}\n` +
            `• *User Mappings*: ${users}\n` +
            `• *Configuration*: ${this.isProperlyConfigured() ? '✅ Valid' : '❌ Invalid'}\n` +
            `• *Messages Forwarded*: ${this.stats.messagesForwarded}\n` +
            `• *Media Forwarded*: ${this.stats.mediaForwarded}\n` +
            `• *Topics Created*: ${this.stats.topicsCreated}`;

        await this.telegramBot.sendMessage(msg.chat.id, statusText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async handleGetGroupsCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        try {
            const groups = await this.bot.sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);

            if (groupList.length === 0) {
                return this.telegramBot.sendMessage(msg.chat.id, '📭 No groups found', {
                    message_thread_id: msg.message_thread_id
                });
            }

            let outputText = `📋 *WhatsApp Groups (${groupList.length})*\n\n`;
            
            for (let i = 0; i < groupList.length; i++) {
                const group = groupList[i];
                const groupInfo = `${i + 1}. ${group.subject}\n` +
                                 `   \`${group.id}\`\n\n`;
                
                if ((outputText + groupInfo).length > 4000) {
                    await this.telegramBot.sendMessage(msg.chat.id, outputText, {
                        message_thread_id: msg.message_thread_id,
                        parse_mode: 'Markdown'
                    });
                    outputText = groupInfo;
                    await this.sleep(500);
                } else {
                    outputText += groupInfo;
                }
            }

            if (outputText.length > 0) {
                await this.telegramBot.sendMessage(msg.chat.id, outputText, {
                    message_thread_id: msg.message_thread_id,
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            logger.error('❌ Failed to get groups:', error);
            await this.sendErrorMessage(msg, 'Failed to retrieve groups', error);
        }
    }

    async handleFindContactCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0]) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                `❓ *Usage:* \`/tgfind <search_string>\`\n*Example:* \`/tgfind john\``, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        const query = params.join(' ').toLowerCase();
        const results = await this.fuzzyFindContacts(query);

        if (results.length === 0) {
            return this.telegramBot.sendMessage(msg.chat.id, '❌ No matching contacts found', {
                message_thread_id: msg.message_thread_id
            });
        }

        let outputText = `🔍 *Search Results for "${query}" (${results.length})*\n\n`;
        
        for (const result of results.slice(0, 20)) { // Limit to 20 results
            outputText += `• *${result.name}*\n  \`${result.jid}\`\n\n`;
        }

        if (results.length > 20) {
            outputText += `... and ${results.length - 20} more results`;
        }

        await this.telegramBot.sendMessage(msg.chat.id, outputText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async handleRevokeCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!msg.reply_to_message) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❓ *Usage:* Reply to a message with `/tgrevoke`', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        try {
            const whatsappJid = this.findWhatsAppJidByTopic(msg.message_thread_id);
            if (!whatsappJid) {
                return this.telegramBot.sendMessage(msg.chat.id, 
                    '❌ Could not find WhatsApp chat for this thread', {
                    message_thread_id: msg.message_thread_id
                });
            }

            const messagePair = this.findMessagePair(msg.reply_to_message.message_id);
            if (!messagePair) {
                return this.telegramBot.sendMessage(msg.chat.id, 
                    '❌ Could not find WhatsApp message to revoke', {
                    message_thread_id: msg.message_thread_id
                });
            }

            // Send revoke message to WhatsApp
            await this.bot.sock.sendMessage(whatsappJid, {
                delete: {
                    remoteJid: whatsappJid,
                    fromMe: true,
                    id: messagePair.whatsappId
                }
            });

            await this.telegramBot.sendMessage(msg.chat.id, '✅ *Message revoked successfully*', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });

        } catch (error) {
            logger.error('❌ Failed to revoke message:', error);
            await this.sendErrorMessage(msg, 'Failed to revoke message', error);
        }
    }

    async handleSyncContactsCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        await this.telegramBot.sendMessage(msg.chat.id, 
            '🔄 Starting contact sync... this may take some time', {
            message_thread_id: msg.message_thread_id
        });

        try {
            // Sync contacts from WhatsApp
            await this.syncAllContacts();
            
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Successfully synced ${this.userMappings.size} contacts`, {
                message_thread_id: msg.message_thread_id
            });
        } catch (error) {
            logger.error('❌ Failed to sync contacts:', error);
            await this.sendErrorMessage(msg, 'Failed to sync contacts', error);
        }
    }

    async handleClearHistoryCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        const count = this.messagePairs.size;
        this.messagePairs.clear();
        this.statusMessageIds.clear();

        await this.telegramBot.sendMessage(msg.chat.id, 
            `✅ Cleared ${count} message pairs from history`, {
            message_thread_id: msg.message_thread_id
        });
    }

    async handleRestartWACommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        try {
            await this.telegramBot.sendMessage(msg.chat.id, 
                '🔄 Restarting WhatsApp connection...', {
                message_thread_id: msg.message_thread_id
            });

            // Restart WhatsApp connection
            if (this.bot.sock) {
                this.bot.sock.ws.close();
                await this.sleep(2000);
                await this.bot.startWhatsApp();
            }

            await this.telegramBot.sendMessage(msg.chat.id, 
                '✅ WhatsApp connection restarted successfully', {
                message_thread_id: msg.message_thread_id
            });
        } catch (error) {
            logger.error('❌ Failed to restart WhatsApp:', error);
            await this.sendErrorMessage(msg, 'Failed to restart WhatsApp connection', error);
        }
    }

    async handleJoinGroupCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0]) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❓ *Usage:* `/tgjoin <invite_link>`', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        try {
            const inviteLink = params[0];
            const inviteCode = inviteLink.split('/').pop();
            const result = await this.bot.sock.groupAcceptInvite(inviteCode);
            
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Successfully joined group: \`${result}\``, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Failed to join group:', error);
            await this.sendErrorMessage(msg, 'Failed to join group', error);
        }
    }

    async handleSetTargetGroupCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0]) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❓ *Usage:* `/tgsetgroup <group_id>`\n*Note:* Send this command in a topic', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        if (!msg.message_thread_id) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ This command must be sent in a topic thread');
        }

        try {
            const groupId = params[0];
            
            // Verify group exists
            const groupMeta = await this.bot.sock.groupMetadata(groupId);
            
            // Check if mapping already exists
            if (this.chatMappings.has(groupId)) {
                return this.telegramBot.sendMessage(msg.chat.id, 
                    '❌ A topic already exists for this WhatsApp group', {
                    message_thread_id: msg.message_thread_id
                });
            }

            // Create mapping
            this.chatMappings.set(groupId, msg.message_thread_id);
            
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Successfully mapped this topic to group: *${groupMeta.subject}*`, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Failed to set target group:', error);
            await this.sendErrorMessage(msg, 'Failed to set target group', error);
        }
    }

    async handleSetTargetPrivateCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0]) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❓ *Usage:* `/tgsetprivate <user_id>`\n*Note:* Send this command in a topic', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        if (!msg.message_thread_id) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ This command must be sent in a topic thread');
        }

        try {
            const userId = params[0];
            const userJid = this.normalizeJid(userId);
            
            // Check if mapping already exists
            if (this.chatMappings.has(userJid)) {
                return this.telegramBot.sendMessage(msg.chat.id, 
                    '❌ A topic already exists for this WhatsApp user', {
                    message_thread_id: msg.message_thread_id
                });
            }

            // Create mapping
            this.chatMappings.set(userJid, msg.message_thread_id);
            
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Successfully mapped this topic to user: \`${userJid}\``, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Failed to set target private chat:', error);
            await this.sendErrorMessage(msg, 'Failed to set target private chat', error);
        }
    }

    async handleUnlinkThreadCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!msg.message_thread_id) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ This command must be sent in a topic thread');
        }

        const whatsappJid = this.findWhatsAppJidByTopic(msg.message_thread_id);
        if (!whatsappJid) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ No WhatsApp chat mapping found for this thread', {
                message_thread_id: msg.message_thread_id
            });
        }

        this.chatMappings.delete(whatsappJid);
        
        await this.telegramBot.sendMessage(msg.chat.id, 
            '✅ Successfully unlinked this thread from WhatsApp chat', {
            message_thread_id: msg.message_thread_id
        });
    }

    async handleGetProfilePictureCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0]) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❓ *Usage:* `/tgpic <user/group_id>`\n*Note:* Add `@g.us` for groups', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        try {
            const jid = params[0];
            const profilePicUrl = await this.bot.sock.profilePictureUrl(jid, 'image');
            
            if (profilePicUrl) {
                await this.telegramBot.sendPhoto(msg.chat.id, profilePicUrl, {
                    message_thread_id: msg.message_thread_id,
                    caption: `📸 Profile picture for: \`${jid}\``,
                    parse_mode: 'Markdown'
                });
            } else {
                await this.telegramBot.sendMessage(msg.chat.id, 
                    '❌ No profile picture found for this user/group', {
                    message_thread_id: msg.message_thread_id
                });
            }
        } catch (error) {
            logger.error('❌ Failed to get profile picture:', error);
            await this.sendErrorMessage(msg, 'Failed to get profile picture', error);
        }
    }

    async handleSyncTopicNamesCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        await this.telegramBot.sendMessage(msg.chat.id, 
            '🔄 Syncing topic names...', {
            message_thread_id: msg.message_thread_id
        });

        let updated = 0;
        for (const [jid, topicId] of this.chatMappings.entries()) {
            try {
                let newName = '';
                
                if (jid.endsWith('@g.us')) {
                    const groupMeta = await this.bot.sock.groupMetadata(jid);
                    newName = groupMeta.subject;
                } else if (jid === 'status@broadcast') {
                    newName = '📊 Status Updates';
                } else if (jid === 'call@broadcast') {
                    newName = '📞 Call Logs';
                } else {
                    const userInfo = this.userMappings.get(jid);
                    newName = userInfo?.name || jid.split('@')[0];
                }

                if (newName) {
                    await this.telegramBot.editForumTopic(msg.chat.id, topicId, {
                        name: newName
                    });
                    updated++;
                    await this.sleep(1000); // Rate limiting
                }
            } catch (error) {
                logger.debug(`Could not update topic for ${jid}:`, error);
            }
        }

        await this.telegramBot.sendMessage(msg.chat.id, 
            `✅ Updated ${updated} topic names`, {
            message_thread_id: msg.message_thread_id
        });
    }

    async handleSendCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!params[0] || !msg.reply_to_message) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❓ *Usage:* Reply to a message with `/tgsend <target_id>`\n*Example:* `/tgsend 1234567890`', {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        }

        try {
            const targetJid = this.normalizeJid(params[0]);
            const messageToSend = msg.reply_to_message;
            
            await this.forwardTelegramMessageToWhatsApp(messageToSend, targetJid);
            
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Message sent to: \`${targetJid}\``, {
                message_thread_id: msg.message_thread_id,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Failed to send message:', error);
            await this.sendErrorMessage(msg, 'Failed to send message', error);
        }
    }

    async handleHelpCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        let helpText = '📋 *Available Telegram Bridge Commands*\n\n';
        
        for (const cmd of this.commands) {
            if (cmd.description) {
                helpText += `• \`/${cmd.name}\` - ${cmd.description}\n`;
            }
        }

        await this.telegramBot.sendMessage(msg.chat.id, helpText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async handleBlockCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!msg.message_thread_id) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ This command must be sent in a topic thread');
        }

        const whatsappJid = this.findWhatsAppJidByTopic(msg.message_thread_id);
        if (!whatsappJid) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ No WhatsApp chat found for this thread', {
                message_thread_id: msg.message_thread_id
            });
        }

        try {
            await this.bot.sock.updateBlockStatus(whatsappJid, 'block');
            await this.telegramBot.sendMessage(msg.chat.id, 
                '✅ User blocked successfully', {
                message_thread_id: msg.message_thread_id
            });
        } catch (error) {
            logger.error('❌ Failed to block user:', error);
            await this.sendErrorMessage(msg, 'Failed to block user', error);
        }
    }

    async handleUnblockCommand(msg, params, context) {
        if (!this.isAuthorized(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        if (!msg.message_thread_id) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ This command must be sent in a topic thread');
        }

        const whatsappJid = this.findWhatsAppJidByTopic(msg.message_thread_id);
        if (!whatsappJid) {
            return this.telegramBot.sendMessage(msg.chat.id, 
                '❌ No WhatsApp chat found for this thread', {
                message_thread_id: msg.message_thread_id
            });
        }

        try {
            await this.bot.sock.updateBlockStatus(whatsappJid, 'unblock');
            await this.telegramBot.sendMessage(msg.chat.id, 
                '✅ User unblocked successfully', {
                message_thread_id: msg.message_thread_id
            });
        } catch (error) {
            logger.error('❌ Failed to unblock user:', error);
            await this.sendErrorMessage(msg, 'Failed to unblock user', error);
        }
    }

    async handleTgBridgeCommand(msg, params, context) {
        if (!this.isOwner(msg.from.id)) {
            return this.sendUnauthorizedMessage(msg);
        }

        const action = params[0]?.toLowerCase();

        switch (action) {
            case 'start':
                if (this.telegramBot) {
                    return this.telegramBot.sendMessage(msg.chat.id, 
                        '✅ Telegram bridge is already running!', {
                        message_thread_id: msg.message_thread_id
                    });
                }
                
                const started = await this.initializeTelegramBot();
                return this.telegramBot.sendMessage(msg.chat.id, 
                    started ? '✅ Telegram bridge started!' : '❌ Failed to start bridge', {
                    message_thread_id: msg.message_thread_id
                });

            case 'stop':
                if (!this.telegramBot) {
                    return this.telegramBot.sendMessage(msg.chat.id, 
                        '❌ Telegram bridge is not running!', {
                        message_thread_id: msg.message_thread_id
                    });
                }
                
                await this.stopTelegramBot();
                return this.telegramBot.sendMessage(msg.chat.id, 
                    '🛑 Telegram bridge stopped.', {
                    message_thread_id: msg.message_thread_id
                });

            case 'status':
                return this.handleStartCommand(msg, params, context);

            default:
                return this.telegramBot.sendMessage(msg.chat.id, 
                    `❓ *Telegram Bridge Commands*\n\n` +
                    `• \`tgbridge start\` - Start the bridge\n` +
                    `• \`tgbridge stop\` - Stop the bridge\n` +
                    `• \`tgbridge status\` - Show status`, {
                    message_thread_id: msg.message_thread_id,
                    parse_mode: 'Markdown'
                });
        }
    }

    // Message hook handlers - Complete implementation from WatgBridge
    async onWhatsAppConnected(data) {
        logger.info('📱 WhatsApp connected - initializing Telegram sync');
        if (this.telegramBot) {
            await this.syncWhatsAppConnection();
        }
    }

    async onMessageReceived(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { msg } = data;
        logger.debug(`📩 Processing WhatsApp message from ${msg.key.remoteJid}`);
        await this.syncWhatsAppMessage(msg);
    }

    async onStatusReceived(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { msg } = data;
        logger.debug('📊 Processing WhatsApp status message');
        await this.syncWhatsAppMessage(msg);
    }

    async onCallReceived(data) {
        if (!this.telegramBot || !this.config.enabled) return;

        const { call } = data;
        logger.debug(`📞 Processing call: ${call.status} from ${call.from}`);
        await this.handleCallNotification(call);
    }

    async onGroupParticipantsUpdate(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { id, participants, action } = data;
        await this.handleGroupParticipantsUpdate(id, participants, action);
    }

    async onGroupUpdate(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { id, update } = data;
        await this.handleGroupUpdate(id, update);
    }

    async onPresenceUpdate(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { id, presences } = data;
        await this.handlePresenceUpdate(id, presences);
    }

    async onMessageRevoked(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { msg } = data;
        await this.handleMessageRevoked(msg);
    }

    async onMessageReaction(data) {
        if (!this.telegramBot || !this.config.enabled) return;
        
        const { msg } = data;
        await this.handleMessageReaction(msg);
    }

    // Core sync functions - Complete implementation from WatgBridge
    async syncWhatsAppMessage(whatsappMsg) {
        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            
            // Update user mapping
            await this.updateUserMapping(participant, whatsappMsg);
            
            // Get or create topic
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            if (!topicId) return;

            // Handle different message types
            const message = whatsappMsg.message;
            let sentMessageId = null;
            
            if (message?.imageMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
            } else if (message?.videoMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
            } else if (message?.audioMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
            } else if (message?.documentMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
            } else if (message?.stickerMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
            } else if (message?.locationMessage) {
                sentMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
            } else if (message?.contactMessage || message?.contactsArrayMessage) {
                sentMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
            } else {
                const text = this.extractText(whatsappMsg);
                if (text) {
                    sentMessageId = await this.sendSimpleMessage(topicId, text, sender, participant);
                }
            }

            // Store message pair for revoke functionality
            if (sentMessageId && whatsappMsg.key.id) {
                this.messagePairs.set(sentMessageId, {
                    whatsappId: whatsappMsg.key.id,
                    whatsappJid: sender,
                    telegramMessageId: sentMessageId,
                    timestamp: new Date()
                });
            }

            this.stats.messagesForwarded++;

        } catch (error) {
            logger.error('❌ Error syncing WhatsApp message:', error);
            this.stats.errors++;
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            const message = whatsappMsg.message;
            const mediaMessage = message[`${mediaType}Message`];
            
            if (!mediaMessage) return null;

            // Download media
            const buffer = await downloadContentFromMessage(mediaMessage, mediaType);
            const chunks = [];
            for await (const chunk of buffer) {
                chunks.push(chunk);
            }
            const mediaBuffer = Buffer.concat(chunks);

            // Send to Telegram based on media type
            let result;
            const caption = this.formatMessageCaption(whatsappMsg);
            const options = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown'
            };
            
            switch (mediaType) {
                case 'image':
                    result = await this.telegramBot.sendPhoto(this.config.chatId, mediaBuffer, options);
                    break;
                case 'video':
                    result = await this.telegramBot.sendVideo(this.config.chatId, mediaBuffer, options);
                    break;
                case 'audio':
                    result = await this.telegramBot.sendAudio(this.config.chatId, mediaBuffer, options);
                    break;
                case 'document':
                    result = await this.telegramBot.sendDocument(this.config.chatId, mediaBuffer, options);
                    break;
                case 'sticker':
                    result = await this.telegramBot.sendSticker(this.config.chatId, mediaBuffer, {
                        message_thread_id: topicId
                    });
                    break;
            }

            // Add confirmation reaction/message
            if (result && this.config.confirmationType === 'emoji') {
                try {
                    await this.telegramBot.setMessageReaction(this.config.chatId, result.message_id, {
                        reaction: [{ type: 'emoji', emoji: '✅' }]
                    });
                } catch (err) {
                    logger.debug('Could not add reaction:', err);
                }
            }

            this.stats.mediaForwarded++;
            return result?.message_id;

        } catch (error) {
            logger.error(`❌ Error handling ${mediaType}:`, error);
            this.stats.errors++;
            return null;
        }
    }

    async sendSimpleMessage(topicId, text, sender, participant) {
        try {
            const formattedText = this.formatMessage(text, sender, participant);
            
            const result = await this.telegramBot.sendMessage(this.config.chatId, formattedText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            // Add confirmation reaction/message
            if (result && this.config.confirmationType === 'emoji') {
                try {
                    await this.telegramBot.setMessageReaction(this.config.chatId, result.message_id, {
                        reaction: [{ type: 'emoji', emoji: '✅' }]
                    });
                } catch (err) {
                    logger.debug('Could not add reaction:', err);
                }
            }

            return result.message_id;
        } catch (error) {
            logger.error('❌ Error sending simple message:', error);
            this.stats.errors++;
            return null;
        }
    }

    async getOrCreateTopic(chatId, whatsappMsg) {
        try {
            // Check if topic already exists
            if (this.chatMappings.has(chatId)) {
                return this.chatMappings.get(chatId);
            }

            // Create new topic
            const topicName = await this.generateTopicName(chatId, whatsappMsg);
            
            const result = await this.telegramBot.createForumTopic(this.config.chatId, topicName);
            const topicId = result.message_thread_id;
            
            this.chatMappings.set(chatId, topicId);
            this.stats.topicsCreated++;
            
            // Send user info for private chats
            if (!chatId.endsWith('@g.us') && chatId !== 'status@broadcast') {
                await this.sendUserInfo(chatId, topicId);
            }
            
            return topicId;
        } catch (error) {
            logger.error('❌ Error creating topic:', error);
            this.stats.errors++;
            return null;
        }
    }

    async generateTopicName(chatId, whatsappMsg) {
        if (chatId.endsWith('@g.us')) {
            // Group chat
            try {
                const groupMeta = await this.bot.sock.groupMetadata(chatId);
                return groupMeta.subject || 'Unknown Group';
            } catch {
                return 'WhatsApp Group';
            }
        } else if (chatId === 'status@broadcast') {
            return '📊 Status Updates';
        } else {
            // Private chat
            const participant = whatsappMsg.key.participant || chatId;
            const contact = await this.getContactName(participant);
            return contact || participant.split('@')[0];
        }
    }

    async sendUserInfo(userId, topicId) {
        try {
            const contact = await this.getContactInfo(userId);
            const profilePic = await this.getProfilePicture(userId);
            
            let infoText = `👤 *User Information*\n\n`;
            infoText += `• *Name*: ${contact.name || 'Unknown'}\n`;
            infoText += `• *Number*: ${userId.split('@')[0]}\n`;
            infoText += `• *Status*: ${contact.status || 'No status'}\n`;
            
            if (profilePic) {
                await this.telegramBot.sendPhoto(this.config.chatId, profilePic, {
                    message_thread_id: topicId,
                    caption: infoText,
                    parse_mode: 'Markdown'
                });
            } else {
                await this.telegramBot.sendMessage(this.config.chatId, infoText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            logger.error('❌ Error sending user info:', error);
        }
    }

    async handleCallNotification(call) {
        try {
            const callTopicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast' }
            });

            let callText = `📞 *Call Notification*\n\n`;
            callText += `• *From*: ${call.from}\n`;
            callText += `• *Status*: ${call.status}\n`;
            callText += `• *Time*: ${new Date().toLocaleString()}\n`;

            await this.telegramBot.sendMessage(this.config.chatId, callText, {
                message_thread_id: callTopicId,
                parse_mode: 'Markdown'
            });

            this.stats.callsLogged++;
        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    async handleTelegramMessage(msg) {
        try {
            // Skip if it's a command
            if (msg.text && msg.text.startsWith('/')) return;

            // Find WhatsApp chat for this topic
            const whatsappJid = this.findWhatsAppJidByTopic(msg.message_thread_id);
            if (!whatsappJid) return;

            // Forward message to WhatsApp
            await this.forwardTelegramMessageToWhatsApp(msg, whatsappJid);

            // Add confirmation
            if (this.config.confirmationType === 'emoji') {
                try {
                    await this.telegramBot.setMessageReaction(msg.chat.id, msg.message_id, {
                        reaction: [{ type: 'emoji', emoji: '👍' }]
                    });
                } catch (err) {
                    logger.debug('Could not add reaction:', err);
                }
            }

        } catch (error) {
            logger.error('❌ Error handling Telegram message:', error);
        }
    }

    async forwardTelegramMessageToWhatsApp(msg, targetJid) {
        try {
            let messageContent = {};

            if (msg.text) {
                messageContent = { text: msg.text };
            } else if (msg.photo) {
                const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
                const file = await this.telegramBot.getFile(photo.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);

                const uploadResponse = await this.bot.sock.sendMessage(targetJid, {
                    image: buffer,
                    caption: msg.caption || ''
                });
                return uploadResponse;
            } else if (msg.video) {
                const file = await this.telegramBot.getFile(msg.video.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);

                const uploadResponse = await this.bot.sock.sendMessage(targetJid, {
                    video: buffer,
                    caption: msg.caption || ''
                });
                return uploadResponse;
            } else if (msg.audio) {
                const file = await this.telegramBot.getFile(msg.audio.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);

                const uploadResponse = await this.bot.sock.sendMessage(targetJid, {
                    audio: buffer,
                    mimetype: 'audio/mp4'
                });
                return uploadResponse;
            } else if (msg.document) {
                const file = await this.telegramBot.getFile(msg.document.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);

                const uploadResponse = await this.bot.sock.sendMessage(targetJid, {
                    document: buffer,
                    fileName: msg.document.file_name || 'document',
                    mimetype: msg.document.mime_type || 'application/octet-stream'
                });
                return uploadResponse;
            } else if (msg.sticker) {
                const file = await this.telegramBot.getFile(msg.sticker.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);

                // Convert to WebP if needed
                let stickerBuffer = buffer;
                if (!msg.sticker.is_animated) {
                    try {
                        stickerBuffer = await sharp(buffer)
                            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                            .webp()
                            .toBuffer();
                    } catch (err) {
                        logger.debug('Could not convert sticker:', err);
                    }
                }

                const uploadResponse = await this.bot.sock.sendMessage(targetJid, {
                    sticker: stickerBuffer
                });
                return uploadResponse;
            }

            if (Object.keys(messageContent).length > 0) {
                return await this.bot.sock.sendMessage(targetJid, messageContent);
            }

        } catch (error) {
            logger.error('❌ Error forwarding Telegram message to WhatsApp:', error);
            throw error;
        }
    }

    // Utility methods
    isAuthorized(userId) {
        return this.config.ownerIds.includes(userId) || 
               this.config.sudoUsers.includes(userId);
    }

    isOwner(userId) {
        return this.config.ownerIds.includes(userId);
    }

    isProperlyConfigured() {
        return this.config.botToken && 
               !this.config.botToken.includes('YOUR_TELEGRAM_BOT_TOKEN_HERE') &&
               this.config.chatId && 
               !this.config.chatId.toString().includes('YOUR_TELEGRAM_CHAT_ID_HERE');
    }

    getUptime() {
        const uptime = Date.now() - this.startTime.getTime();
        const seconds = Math.floor(uptime / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    normalizeJid(jid) {
        if (jid.includes('@')) return jid;
        return `${jid}@s.whatsapp.net`;
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               '';
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) return jid;
        }
        return null;
    }

    findMessagePair(telegramMessageId) {
        return this.messagePairs.get(telegramMessageId);
    }

    formatMessage(text, sender, participant) {
        const senderName = this.getContactName(participant) || participant.split('@')[0];
        return `*${senderName}*: ${text}`;
    }

    formatMessageCaption(whatsappMsg) {
        const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
        const senderName = this.getContactName(participant) || participant.split('@')[0];
        const caption = this.extractText(whatsappMsg);
        
        if (caption) {
            return `*${senderName}*: ${caption}`;
        }
        return `*${senderName}* sent media`;
    }

    async getContactName(jid) {
        if (this.userMappings.has(jid)) {
            return this.userMappings.get(jid).name;
        }
        
        try {
            const contact = await this.bot.sock.getBusinessProfile(jid);
            return contact?.name || jid.split('@')[0];
        } catch {
            return jid.split('@')[0];
        }
    }

    async getContactInfo(jid) {
        try {
            const contact = await this.bot.sock.getBusinessProfile(jid);
            return {
                name: contact?.name || 'Unknown',
                status: contact?.description || 'No status'
            };
        } catch {
            return {
                name: 'Unknown',
                status: 'No status'
            };
        }
    }

    async getProfilePicture(jid) {
        try {
            const profilePic = await this.bot.sock.profilePictureUrl(jid, 'image');
            return profilePic;
        } catch {
            return null;
        }
    }

    async fuzzyFindContacts(query) {
        // Simple fuzzy search implementation
        const results = [];
        for (const [jid, info] of this.userMappings.entries()) {
            if (info.name && info.name.toLowerCase().includes(query)) {
                results.push({ jid, name: info.name });
            }
        }
        return results;
    }

    async syncAllContacts() {
        // Sync contacts from WhatsApp
        try {
            const contacts = await this.bot.sock.getContacts();
            for (const contact of contacts) {
                this.userMappings.set(contact.id, {
                    name: contact.name || contact.notify || contact.id.split('@')[0],
                    status: contact.status || ''
                });
            }
        } catch (error) {
            logger.error('Error syncing contacts:', error);
        }
    }

    async updateUserMapping(participant, whatsappMsg) {
        if (!this.userMappings.has(participant)) {
            const name = whatsappMsg.pushName || participant.split('@')[0];
            this.userMappings.set(participant, { name, status: '' });
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const location = whatsappMsg.message.locationMessage;
            const locationText = `📍 *Location*\n\nLatitude: ${location.degreesLatitude}\nLongitude: ${location.degreesLongitude}`;
            
            const result = await this.telegramBot.sendLocation(this.config.chatId, 
                location.degreesLatitude, location.degreesLongitude, {
                message_thread_id: topicId
            });

            return result?.message_id;
        } catch (error) {
            logger.error('❌ Error handling location:', error);
            return null;
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId) {
        try {
            const contact = whatsappMsg.message.contactMessage;
            const contactText = `👤 *Contact*\n\n*Name:* ${contact.displayName}\n*VCard:* ${contact.vcard}`;
            
            const result = await this.telegramBot.sendMessage(this.config.chatId, contactText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            return result?.message_id;
        } catch (error) {
            logger.error('❌ Error handling contact:', error);
            return null;
        }
    }

    async handleGroupParticipantsUpdate(id, participants, action) {
        try {
            const topicId = this.chatMappings.get(id);
            if (!topicId) return;

            let updateText = `👥 *Group Update*\n\n`;
            updateText += `*Action:* ${action}\n`;
            updateText += `*Participants:* ${participants.join(', ')}\n`;

            await this.telegramBot.sendMessage(this.config.chatId, updateText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Error handling group participants update:', error);
        }
    }

    async handleGroupUpdate(id, update) {
        try {
            const topicId = this.chatMappings.get(id);
            if (!topicId) return;

            let updateText = `👥 *Group Settings Update*\n\n`;
            if (update.subject) updateText += `*New Subject:* ${update.subject}\n`;
            if (update.desc) updateText += `*New Description:* ${update.desc}\n`;

            await this.telegramBot.sendMessage(this.config.chatId, updateText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Error handling group update:', error);
        }
    }

    async handlePresenceUpdate(id, presences) {
        if (!this.config.sendPresence) return;
        
        try {
            const topicId = this.chatMappings.get(id);
            if (!topicId) return;

            for (const [jid, presence] of Object.entries(presences)) {
                const name = this.getContactName(jid) || jid.split('@')[0];
                const presenceText = `👁️ *${name}* is ${presence.lastKnownPresence}`;

                await this.telegramBot.sendMessage(this.config.chatId, presenceText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            logger.error('❌ Error handling presence update:', error);
        }
    }

    async handleMessageRevoked(msg) {
        try {
            const topicId = this.chatMappings.get(msg.key.remoteJid);
            if (!topicId) return;

            const revokeText = `🗑️ *Message Revoked*\n\nA message was deleted by the sender.`;

            await this.telegramBot.sendMessage(this.config.chatId, revokeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Error handling message revoked:', error);
        }
    }

    async handleMessageReaction(msg) {
        if (!this.config.reactions) return;
        
        try {
            const topicId = this.chatMappings.get(msg.key.remoteJid);
            if (!topicId) return;

            const reaction = msg.message.reactionMessage;
            const reactionText = `😀 *Reaction:* ${reaction.text}`;

            await this.telegramBot.sendMessage(this.config.chatId, reactionText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            this.stats.reactionsHandled++;
        } catch (error) {
            logger.error('❌ Error handling message reaction:', error);
        }
    }

    async handleCallbackQuery(query) {
        try {
            // Handle revoke button callbacks
            if (query.data.startsWith('revoke_')) {
                const [, messageId, chatId, confirm] = query.data.split('_');
                
                if (confirm === 'y') {
                    // Perform revoke
                    await this.bot.sock.sendMessage(chatId, {
                        delete: {
                            remoteJid: chatId,
                            fromMe: true,
                            id: messageId
                        }
                    });
                    
                    await this.telegramBot.answerCallbackQuery(query.id, {
                        text: '✅ Message revoked successfully'
                    });
                } else if (confirm === 'n') {
                    await this.telegramBot.answerCallbackQuery(query.id, {
                        text: '❌ Revoke cancelled'
                    });
                }
            }
        } catch (error) {
            logger.error('❌ Error handling callback query:', error);
        }
    }

    async syncWhatsAppConnection() {
        logger.info('🔄 Syncing WhatsApp connection with Telegram');
        
        // Send connection status to Telegram
        if (this.config.chatId) {
            try {
                await this.telegramBot.sendMessage(this.config.chatId, 
                    '✅ *WhatsApp Connected*\n\nTelegram bridge is now active and ready to forward messages.', {
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                logger.error('Error sending connection status:', error);
            }
        }
    }

    async sendStartupMessage() {
        if (!this.config.chatId) return;
        
        const message = 
            `🚀 *Telegram Bridge Started*\n\n` +
            `• *Version*: ${this.version}\n` +
            `• *Status*: ✅ Active\n` +
            `• *Features*: All WatgBridge features enabled\n\n` +
            `Ready to bridge WhatsApp and Telegram! 🌉`;

        try {
            await this.telegramBot.sendMessage(this.config.chatId, message, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('Failed to send startup message:', error);
        }
    }

    async stopTelegramBot() {
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                this.telegramBot = null;
                logger.info('📱 Telegram bot stopped.');
            } catch (error) {
                logger.error('Error stopping Telegram bot:', error);
            }
        }
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async sendUnauthorizedMessage(msg) {
        await this.telegramBot.sendMessage(msg.chat.id, 
            '❌ You are not authorized to use this bot.', {
            message_thread_id: msg.message_thread_id
        });
    }

    async sendErrorMessage(msg, title, error) {
        const errorText = `❌ *${title}*\n\n\`${error.message || error}\``;
        await this.telegramBot.sendMessage(msg.chat.id, errorText, {
            message_thread_id: msg.message_thread_id,
            parse_mode: 'Markdown'
        });
    }

    async shutdown() {
        logger.info('🛑 Shutting down Complete Telegram Bridge module...');
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
        
        logger.info('✅ Complete Telegram Bridge module shutdown complete.');
    }
}

module.exports = TelegramBridge;
