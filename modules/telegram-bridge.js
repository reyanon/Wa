//  Imports & Class Setup
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const reactions = require('./reactionHandler');
const confirm = require('./telegramBridge-confirmation');


// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp User -> Telegram User Data
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map(); // Track active calls to prevent spam
        this.statusMessageIds = new Map(); // Track status message IDs for replies
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        if (!token || token.includes('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ')) {
            logger.warn('⚠️ Telegram bot token not configured properly');
            return;
        }

        try {
            await fs.ensureDir(this.tempDir);
            this.telegramBot = new TelegramBot(token, { polling: true });
            await this.setupTelegramHandlers();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async setupTelegramHandlers() {
        this.telegramBot.on('message', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        });

        this.telegramBot.on('photo', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'photo');
            }
        });

        this.telegramBot.on('video', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'video');
            }
        });

        this.telegramBot.on('video_note', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'video_note');
            }
        });

        this.telegramBot.on('voice', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'voice');
            }
        });

        this.telegramBot.on('audio', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'audio');
            }
        });

        this.telegramBot.on('document', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'document');
            }
        });

        this.telegramBot.on('sticker', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMedia(msg, 'sticker');
            }
        });

        this.telegramBot.on('location', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramLocation(msg);
            }
        });

        this.telegramBot.on('contact', async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramContact(msg);
            }
        });

        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

// Message Sync, Topic Creation, Message Handling

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;

        await this.createUserMapping(participant, whatsappMsg);
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);

        if (whatsappMsg.message?.imageMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage) {
            await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.contactMessage) {
            await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else if (text) {
            const messageId = await this.sendSimpleMessage(topicId, text, sender);
            if (sender === 'status@broadcast') {
                this.statusMessageIds.set(messageId, whatsappMsg.key);
            }
        }
    }

    async handleTelegramMessage(msg) {
        if (msg.photo || msg.video || msg.video_note || msg.voice || msg.audio || msg.document || msg.sticker || msg.location || msg.contact) {
            return;
        }

        if (!msg.text) return;

        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
                await this.handleStatusReply(msg);
                return;
            }

            await this.whatsappBot.sendMessage(whatsappJid, { text: msg.text });
            await confirm.confirmTelegramDelivery(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
        }
    }

    async handleStatusReply(msg) {
        try {
            const originalStatusKey = this.statusMessageIds.get(msg.reply_to_message.message_id);
            if (!originalStatusKey) {
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Cannot find original status message to reply to', {
                    message_thread_id: msg.message_thread_id
                });
                return;
            }

            const statusJid = originalStatusKey.participant || originalStatusKey.remoteJid;
            await this.whatsappBot.sendMessage(statusJid, { text: msg.text });

            await confirm.confirmStatusReply(this.telegramBot, msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await confirm.confirmTelegramFailure(this.telegramBot, msg.chat.id, msg.message_id);
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) return;

        let userName = null;
        let userPhone = participant.split('@')[0];

        try {
            if (this.whatsappBot.sock) {
                const contact = await this.whatsappBot.sock.onWhatsApp(participant);
                if (contact && contact[0] && contact[0].notify) {
                    userName = contact[0].notify;
                }

                if (whatsappMsg.pushName) {
                    userName = whatsappMsg.pushName;
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

        logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`);
    }

// Final Features, Shutdown, Extensions

    async forwardWhatsAppReaction(jid, reaction) {
        try {
            const topicId = await this.getOrCreateTopic(jid, { key: { remoteJid: jid } });
            const chatId = config.get('telegram.chatId');
            const userInfo = this.userMappings.get(reaction.sender) || {};
            const name = userInfo.name || reaction.sender.split('@')[0];

            const message = `❤️ Reaction from *${name}*: \`${reaction.emoji}\``;
            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            logger.debug(`💬 Forwarded reaction from ${name}`);
        } catch (error) {
            logger.error('❌ Failed to forward WhatsApp reaction:', error);
        }
    }

    async notifyAboutTextChange(jid, aboutText) {
        try {
            const topicId = await this.getOrCreateTopic(jid, { key: { remoteJid: jid } });
            const chatId = config.get('telegram.chatId');
            const userInfo = this.userMappings.get(jid) || {};
            const name = userInfo.name || jid.split('@')[0];

            const message = `✏️ *${name}* updated their *About*:\n\n_${aboutText}_`;
            await this.telegramBot.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            logger.debug(`📝 Sent about change notification for ${name}`);
        } catch (error) {
            logger.error('❌ Failed to send about change notification:', error);
        }
    }

    async forwardViewOnceMedia(msg, topicId, filePath, caption) {
        try {
            const chatId = config.get('telegram.chatId');
            const opts = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown',
                has_spoiler: true
            };

            if (msg.imageMessage) {
                await this.telegramBot.sendPhoto(chatId, filePath, opts);
            } else if (msg.videoMessage) {
                await this.telegramBot.sendVideo(chatId, filePath, opts);
            }

            logger.debug('📸 Sent view-once media as spoiler');
        } catch (error) {
            logger.error('❌ Failed to send view-once media as spoiler:', error);
        }
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
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

        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;

// 
