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
                if (!msg.message) {
                    // Log message stub types even if no 'message' field
                    if (msg.messageStubType) {
                        logger.debug(`Received message stub type: ${msg.messageStubType} from ${msg.key.remoteJid}`);
                    }
                    // Continue processing stub types or return if no relevant info
                    // If no message and no stub type, just skip
                    if (!msg.messageStubType) continue;
                }

                await this.processMessage(msg);
            } catch (error) {
                logger.error('❌ Error processing message:', error);
            }
        }
    }

    async processMessage(msg) {
        const text = this.extractText(msg);
        const sender = msg.key.remoteJid;

        logger.debug(`Processing message from ${sender}, type: ${msg.messageStubType || 'regular message'}`);

        // Handle status updates
        if (sender === 'status@broadcast') {
            logger.info(`📸 Detected Status from ${msg.key.participant || 'unknown'}`);
            await this.handleStatusMessage(msg, text);
            return; // Important: Don't process status as a regular message
        }

        // Handle profile picture updates (StubType 5 can also be other events, refine if needed)
        // Note: For actual profile picture updates, msg.messageStubType is usually 5
        // and messageStubParameters might contain the JID of the updated profile.
        if (msg.messageStubType === 5 && config.get('telegram.settings.autoUpdateProfilePics')) {
            logger.info(`🖼️ Detected Profile Picture Update Stub Type 5 from ${sender}`);
            await this.handleProfilePictureUpdate(msg);
            // This might not always return if stub type 5 can be combined with other message types.
            // For now, let it continue if it's not exclusively a profile pic update.
        }

        // Handle call messages
        if (msg.messageStubType && this.isCallMessage(msg) && config.get('telegram.settings.syncCalls')) {
            logger.info(`📞 Detected Call Message Stub Type ${msg.messageStubType} from ${sender}`);
            await this.handleCallMessage(msg);
            return; // Important: Don't process call as a regular message
        }

        // Handle command messages
        if (text && text.startsWith(config.get('bot.prefix'))) {
            if (config.get('features.rateLimiting') && !rateLimiter.canExecute(sender, 'command')) {
                await this.bot.sendMessage(sender, { text: 'You are sending commands too quickly. Please wait a moment.' });
                return;
            }
            const args = text.slice(config.get('bot.prefix').length).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            const handler = this.commandHandlers.get(command);
            if (handler) {
                if (this.checkPermissions(msg, command)) {
                    logger.info(`⚡ Executing command: ${command} from ${sender}`);
                    await handler(this.bot, msg, args);
                } else {
                    logger.warn(`🚫 Permission denied for command: ${command} from ${sender}`);
                    await this.bot.sendMessage(sender, { text: 'You do not have permission to use this command.' });
                }
            } else {
                // If a command is not found, it might be intended for Telegram or external.
                // We don't send "command not found" to avoid spam for mistyped commands.
                logger.debug(`Command not found: ${command}`);
            }
            return; // Command handled, prevent further processing as regular text
        }

        // Handle regular text messages (only if not a command, status, or call)
        if (text && !msg.key.fromMe) { // Don't bridge messages sent by the bot itself
            if (config.get('features.telegramBridge') && this.bot.telegramBridge) {
                logger.debug(`Bridging text message from ${sender}`);
                await this.bot.telegramBridge.syncMessage(msg, text);
            }
        }
    }

    async handleStatusMessage(msg, text) {
        if (!this.bot.telegramBridge || !config.get('telegram.settings.syncStatus')) return;

        // Ensure status messages are automatically viewed
        if (config.get('features.autoViewStatus')) {
            await this.bot.sock.readMessages([msg.key]);
            logger.debug(`Auto-viewed status from ${msg.key.participant || msg.key.remoteJid}`);
        }

        const statusPosterJid = msg.key.participant || msg.key.remoteJid;
        const senderName = msg.pushName || statusPosterJid.split('@')[0];
        const statusType = msg.message?.imageMessage ? 'Image Status' :
                           msg.message?.videoMessage ? 'Video Status' :
                           'Text Status';

        let messageToSend = `*New ${statusType} from ${senderName}*`;
        if (text) {
            messageToSend += `:\n\n${text}`;
        }

        logger.debug(`Syncing status message to Telegram: ${statusType} from ${senderName}`);

        // syncMessage will determine the media type and handle it appropriately.
        // It's crucial that `msg` contains the correct message structure for media types.
        await this.bot.telegramBridge.syncMessage(msg, messageToSend);
    }

    async handleCallMessage(msg) {
        if (!this.bot.telegramBridge || !config.get('telegram.settings.syncCalls')) return;

        const callType = this.getCallType(msg.messageStubType);
        const callerJid = msg.key.participant || msg.key.remoteJid;
        const callerName = msg.pushName || callerJid.split('@')[0];

        // messageStubParameters can contain more details like video/group call
        const isVideoCall = msg.messageStubParameters && msg.messageStubParameters.includes('true'); // Simplified check
        const isGroupCall = msg.messageStubParameters && msg.messageStubParameters.includes('Group'); // Placeholder, actual value depends on Baileys

        let callDetails = `*Call Log:* ${callType} call from ${callerName}`;
        if (isVideoCall) callDetails += ' (Video)';
        if (isGroupCall) callDetails += ' (Group)';

        // Attempt to extract duration from messageStubParameters if available
        // This is highly dependent on Baileys message structure for call stubs
        // Example: some Baileys versions might have duration as a parameter
        const durationParam = msg.messageStubParameters ? msg.messageStubParameters.find(p => p.includes('duration')) : null;
        if (durationParam) {
            const durationMatch = durationParam.match(/duration=(\d+)/);
            if (durationMatch && durationMatch[1]) {
                const durationSeconds = parseInt(durationMatch[1], 10);
                const minutes = Math.floor(durationSeconds / 60);
                const seconds = durationSeconds % 60;
                callDetails += ` (Duration: ${minutes}m ${seconds}s)`;
            }
        }

        logger.debug(`Syncing call message to Telegram: ${callDetails}`);
        // Pass the actual JID that made the call for topic mapping
        await this.bot.telegramBridge.syncMessage({key: {remoteJid: callerJid}}, callDetails);
    }

    isCallMessage(msg) {
        // MessageStubTypes for various call events (missed, incoming, outgoing, etc.)
        const callTypes = [1, 2, 3, 4, 5, 28, 29, 30, 31, 32]; // Expanded typical call stub types
        return callTypes.includes(msg.messageStubType);
    }

    getCallType(stubType) {
        switch (stubType) {
            case 1: return 'Missed';
            case 2: return 'Outgoing';
            case 3: return 'Incoming';
            case 4: return 'Video Call';
            case 5: return 'Ended Call'; // Often paired with a call log
            case 28: return 'Missed Group';
            case 29: return 'Incoming Group';
            case 30: return 'Outgoing Group';
            case 31: return 'Missed Video Group';
            case 32: return 'Outgoing Video Group';
            default: return 'Unknown Call';
        }
    }

    async handleProfilePictureUpdate(msg) {
        if (!this.bot.telegramBridge || !config.get('telegram.settings.autoUpdateProfilePics')) return;

        try {
            // messageStubParameters for stubType 5 often contains the JID that updated their profile.
            // Example: msg.messageStubParameters = ['923298784489@s.whatsapp.net']
            const participant = msg.messageStubParameters && msg.messageStubParameters.length > 0
                ? msg.messageStubParameters[0]
                : msg.key.remoteJid; // Fallback to remoteJid if param is not present

            logger.info(`Attempting to send profile picture for ${participant}`);

            // Ensure the JID exists in chatMappings or is a direct chat.
            // We need to pass the topic ID if it exists, otherwise the JID
            const topicId = this.bot.telegramBridge.chatMappings.get(participant);

            // sendProfilePicture can handle either topicId or JID to find/create topic
            await this.bot.telegramBridge.sendProfilePicture(topicId, participant, true);
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

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.locationMessage?.name || // For location messages
               msg.message?.contactMessage?.displayName || // For contact messages
               msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
               '';
    }
}

module.exports = MessageHandler;
