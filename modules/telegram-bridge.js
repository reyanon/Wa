const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.messageQueue = [];
        this.isProcessing = false;
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle incoming Telegram messages
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        });

        // Handle callback queries
        this.telegramBot.on('callback_query', async (query) => {
            await this.handleCallback(query);
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('2345678901')) {
            logger.debug('Telegram log channel not configured');
            return;
        }

        try {
            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        // Create user mapping if not exists
        await this.createUserMapping(participant, whatsappMsg);
        
        // Get or create topic for this chat
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        // Format message for Telegram
        const formattedMessage = await this.formatWhatsAppMessage(whatsappMsg, text);
        
        // Send to Telegram
        await this.sendToTelegram(topicId, formattedMessage, whatsappMsg);
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        // Extract user info from WhatsApp
        let userName = 'Unknown User';
        let userPhone = participant.split('@')[0];
        
        try {
            // Try to get contact name
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0]) {
                    userName = contact[0].notify || userPhone;
                }
            }
        } catch (error) {
            logger.debug('Could not fetch contact info:', error);
        }

        this.userMappings.set(participant, {
            name: userName,
            phone: userPhone,
            firstSeen: new Date(),
            messageCount: 0
        });

        logger.debug(`👤 Created user mapping: ${userName} (${userPhone})`);
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId || chatId.includes('2345678901')) {
            logger.error('❌ Telegram chat ID not configured properly');
            return null;
        }

        try {
            // Create topic name
            const isGroup = chatJid.endsWith('@g.us');
            let topicName;
            
            if (isGroup) {
                // For groups, try to get group name
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `📱 ${groupMeta.subject}`;
                } catch (error) {
                    topicName = `📱 Group Chat`;
                }
            } else {
                // For individual chats
                const participant = whatsappMsg.key.participant || chatJid;
                const userInfo = this.userMappings.get(participant);
                topicName = `👤 ${userInfo ? userInfo.name : 'Private Chat'}`;
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: isGroup ? 0x6FB9F0 : 0x7ABA3C
            });

            this.chatMappings.set(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id})`);
            
            // Send welcome message to topic
            await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup);
            
            return topic.message_thread_id;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, chatJid, isGroup) {
        const chatId = config.get('telegram.chatId');
        const welcomeMsg = `🔗 *WhatsApp Bridge Connected*\n\n` +
                          `📱 Chat Type: ${isGroup ? 'Group' : 'Private'}\n` +
                          `🆔 WhatsApp ID: \`${chatJid}\`\n` +
                          `⏰ Connected: ${new Date().toLocaleString()}\n\n` +
                          `💬 Messages from this WhatsApp chat will appear here.\n` +
                          `📤 Reply to messages here to send back to WhatsApp.`;

        await this.telegramBot.sendMessage(chatId, welcomeMsg, {
            message_thread_id: topicId,
            parse_mode: 'Markdown'
        });
    }

    async formatWhatsAppMessage(whatsappMsg, text) {
        const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
        const userInfo = this.userMappings.get(participant);
        const timestamp = new Date().toLocaleTimeString();
        
        let formattedText = `👤 *${userInfo ? userInfo.name : 'Unknown'}*\n`;
        formattedText += `📱 ${userInfo ? userInfo.phone : 'Unknown'}\n`;
        formattedText += `🕐 ${timestamp}\n\n`;
        
        if (text) {
            formattedText += `💬 ${text}`;
        }

        // Handle media messages
        if (whatsappMsg.message?.imageMessage) {
            formattedText += `📷 *Image Message*`;
        } else if (whatsappMsg.message?.videoMessage) {
            formattedText += `🎥 *Video Message*`;
        } else if (whatsappMsg.message?.audioMessage) {
            formattedText += `🎵 *Audio Message*`;
        } else if (whatsappMsg.message?.documentMessage) {
            formattedText += `📄 *Document Message*`;
        }

        return formattedText;
    }

    async sendToTelegram(topicId, message, whatsappMsg) {
        if (!topicId) return;

        const chatId = config.get('telegram.chatId');
        
        try {
            // Create inline keyboard for quick actions
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '↩️ Reply', callback_data: `reply_${whatsappMsg.key.id}` },
                        { text: '👤 User Info', callback_data: `info_${whatsappMsg.key.participant || whatsappMsg.key.remoteJid}` }
                    ]
                ]
            };

            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

            // Update user message count
            const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid;
            if (this.userMappings.has(participant)) {
                this.userMappings.get(participant).messageCount++;
            }

        } catch (error) {
            logger.error('❌ Failed to send message to Telegram:', error);
        }
    }

    async handleTelegramMessage(msg) {
        // Handle messages from Telegram back to WhatsApp
        if (!msg.reply_to_message) return;

        try {
            // Find the corresponding WhatsApp chat
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            // Format message for WhatsApp
            const formattedMessage = `📱 *From Telegram:*\n${msg.text}`;
            
            // Send to WhatsApp
            await this.whatsappBot.sendMessage(whatsappJid, { text: formattedMessage });
            
            // Confirm in Telegram
            await this.telegramBot.sendMessage(msg.chat.id, '✅ Message sent to WhatsApp', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
        }
    }

    async handleCallback(query) {
        const [action, data] = query.data.split('_');
        
        try {
            switch (action) {
                case 'reply':
                    await this.handleReplyCallback(query, data);
                    break;
                case 'info':
                    await this.handleInfoCallback(query, data);
                    break;
            }
        } catch (error) {
            logger.error('❌ Failed to handle callback:', error);
        }
    }

    async handleReplyCallback(query, messageId) {
        await this.telegramBot.answerCallbackQuery(query.id, {
            text: '💬 Reply to the message to send back to WhatsApp',
            show_alert: false
        });
    }

    async handleInfoCallback(query, participantId) {
        const userInfo = this.userMappings.get(participantId);
        
        if (userInfo) {
            const infoText = `👤 User: ${userInfo.name}\n📱 Phone: ${userInfo.phone}\n👋 First Seen: ${userInfo.firstSeen.toLocaleString()}\n💬 Messages: ${userInfo.messageCount}`;
            
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: infoText,
                show_alert: true
            });
        } else {
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: '❌ User information not found',
                show_alert: true
            });
        }
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
            logger.info('📱 Telegram bridge stopped');
        }
    }
}

module.exports = TelegramBridge;