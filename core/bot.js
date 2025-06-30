const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const TelegramBridge = require('../watg-bridge/bridge');
const { connectDb } = require('../utils/db');
const ModuleLoader = require('./module-loader');

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.db = null;
        this.moduleLoader = new ModuleLoader(this);
    }

    async initialize() {
        logger.info('🔧 Initializing Advanced WhatsApp Bot...');
        
        // Connect to the database
        try {
            this.db = await connectDb();
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            process.exit(1);
        }

        // Load modules using the ModuleLoader
        await this.moduleLoader.loadModules();
        
        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('✅ Bot initialized successfully!');
    }

    async startWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
        const { version } = await fetchLatestBaileysVersion();

        try {
            this.sock = makeWASocket({
                auth: state,
                version,
                printQRInTerminal: false,
                logger: logger.child({ module: 'baileys' }),
                getMessage: async (key) => ({ conversation: 'Message not found' })
            });

            // Timeout for connection
            const connectionTimeout = setTimeout(() => {
                if (!this.sock.user) {
                    logger.error('❌ WhatsApp connection timed out after 30 seconds');
                    process.exit(1);
                }
            }, 30000);

            this.setupEventHandlers(saveCreds);
            await new Promise(resolve => this.sock.ev.on('connection.update', update => {
                if (update.connection === 'open') {
                    clearTimeout(connectionTimeout);
                    resolve();
                }
            }));
        } catch (error) {
            logger.error('❌ Failed to initialize WhatsApp socket:', error);
            process.exit(1);
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                logger.info('📱 Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                logger.warn(`🔌 Connection closed: ${errorMessage} (Status: ${statusCode})`);
                
                if (statusCode !== DisconnectReason.loggedOut && !this.isShuttingDown) {
                    logger.info('🔄 Attempting to reconnect...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.messageHandler.handleMessages.bind(this.messageHandler));
    }

    async onConnectionOpen() {
        logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        // Initialize Telegram bridge after WhatsApp connection
        if (config.get('telegram.enabled') && config.get('telegram.botToken') && !this.telegramBridge) {
            try {
                this.telegramBridge = new TelegramBridge(this);
                await this.telegramBridge.initialize();
                await this.telegramBridge.setupWhatsAppHandlers();
                logger.info('✅ Telegram bridge initialized after WhatsApp connection');
            } catch (error) {
                logger.error('❌ Failed to initialize Telegram bridge:', error);
            }
        }

        // Send startup message to owner
        await this.sendStartupMessage();
        
        // Notify Telegram bridge of connection
        if (this.telegramBridge) {
            await this.telegramBridge.syncWhatsAppConnection();
        }
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *Advanced Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🛡️ Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n` +
                              `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                              `• 👀 Auto View Status: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n\n` +
                              `Type *${config.get('bot.prefix')}menu* for available commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 WhatsApp Bot Started', startupMessage);
            }
        } catch (error) {
            logger.error('Failed to send startup message:', error);
        }
    }

    async connect() {
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async sendMessage(jid, content) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
        logger.info('🛑 Shutting down bot...');
        this.isShuttingDown = true;
        
        if (this.telegramBridge) {
            await this.telegramBridge.shutdown();
        }
        
        if (this.sock) {
            await this.sock.end();
        }
        
        logger.info('✅ Bot shutdown complete');
    }
}

module.exports = { AdvancedWhatsAppBot };
