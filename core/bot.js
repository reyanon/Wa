const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const ModuleManager = require('./module-loader');
const TelegramBridge = require('./bridge');
const db = require('../utils/db');

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.moduleManager = new ModuleManager(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
    }

    async initialize() {
        logger.info('🔧 Initializing NexusWA Bot...');
        
        // Connect to database
        await db.connect();
        
        // Load modules
        await this.moduleManager.initialize();
        
        // Initialize Telegram bridge if enabled
        if (config.get('telegram.enabled') && config.get('telegram.botToken')) {
            this.telegramBridge = new TelegramBridge(this);
            await this.telegramBridge.initialize();
        }

        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('✅ NexusWA Bot initialized successfully!');
    }

    async startWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            logger: logger.child({ module: 'baileys' }),
            getMessage: async (key) => ({ conversation: 'Message not found' })
        });

        this.setupEventHandlers(saveCreds);
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                logger.info('📱 Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
                
                // Send QR to Telegram if bridge is active
                if (this.telegramBridge) {
                    await this.telegramBridge.sendQRToBot(qr);
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('🔄 Connection closed, reconnecting...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.messageHandler.handleMessages.bind(this.messageHandler));
        
        // Setup Telegram bridge handlers
        if (this.telegramBridge) {
            this.telegramBridge.setupWhatsAppHandlers();
        }
    }

    async onConnectionOpen() {
        logger.info('✅ Connected to WhatsApp!');
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        // Send startup message
        await this.sendStartupMessage();
        
        // Initialize Telegram bridge connection
        if (this.telegramBridge) {
            await this.telegramBridge.syncWhatsAppConnection();
        }
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const moduleStats = this.moduleManager.getModuleStats();
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `📦 *Modules Loaded:*\n` +
                              `• System: ${moduleStats.system}\n` +
                              `• Custom: ${moduleStats.custom}\n` +
                              `• Total: ${moduleStats.total}\n\n` +
                              `🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `🛡️ Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n\n` +
                              `Type *${config.get('bot.prefix')}help* to see all commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
        } catch (error) {
            logger.error('Failed to send startup message:', error);
        }
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
        
        await db.disconnect();
        logger.info('✅ Bot shutdown complete');
    }
}

module.exports = { AdvancedWhatsAppBot };
