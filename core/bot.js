const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const ModuleLoader = require('./module-manager');
const MessageHandler = require('./message-handler');
const { useMongoAuthState } = require('../utils/mongoAuthState');

class NexusWA {
    constructor() {
        this.sock = null;
        this.isShuttingDown = false;
        this.authPath = './auth_info';
        this.startTime = new Date();

        this.moduleLoader = new ModuleLoader(this);
        this.messageHandler = new MessageHandler(this);

        this.stats = {
            messagesReceived: 0,
            messagesSent: 0,
            commandsExecuted: 0,
            errors: 0
        };
    }

    async initialize() {
        logger.info('🔧 Initializing NexusWA...');

        await this.moduleLoader.loadModules();
        await this.startWhatsApp();

        logger.info('✅ NexusWA initialized successfully!');
    }

    async startWhatsApp() {
        if (config.get('bot.clearAuthOnStart')) {
            await fs.remove(this.authPath);
            logger.info('🧹 Cleared auth data');
        }

        const { state, saveCreds } = await useMongoAuthState();
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: logger.child({ module: 'baileys' }),
            generateHighQualityLinkPreview: true,
            getMessage: async () => ({ conversation: 'Message not found' }),
            markOnlineOnConnect: false
        });

        this.setupEventHandlers(saveCreds);
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info('📱 Scan QR to login:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('🔄 Connection closed, reconnecting...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed permanently. Please delete auth and restart.');
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('messages.upsert', async (m) => {
            logger.debug(`🟢 messages.upsert type=${m.type} count=${m.messages.length}`);
            this.stats.messagesReceived += m.messages.length;
            await this.messageHandler.handleMessages(m);
        });

        this.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                await this.messageHandler.triggerMessageHooks('call_received', { call });
            }
        });
    }

    async onConnectionOpen() {
        logger.info('✅ Connected to WhatsApp!');

        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to ${this.sock.user.id}`);
        }

        await this.sendStartupMessage();
        await this.messageHandler.triggerMessageHooks('whatsapp_connected', { user: this.sock.user });
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const modulesCount = this.moduleLoader.listModules().length;
        const mode = config.get('features.mode');
        const telegramBridge = config.get('features.telegramBridge') ? "✅ Enabled" : "❌ Disabled";

        const message =
            `🚀 *Welcome to NexusWA v${config.get('bot.version')}*\n\n` +
            `📦 *Modules Loaded*: ${modulesCount}\n` +
            `⚙️ *Bot Mode*: ${mode}\n` +
            `🤖 *Telegram Bridge*: ${telegramBridge}\n\n` +
            `🛠️ *How to use NexusWA:*\n` +
            `• Type *${config.get('bot.prefix')}menu* to see bot commands and settings\n` +
            `• Type *${config.get('bot.prefix')}help* to see module commands\n\n` +
            `Happy automating with *NexusWA* 🚀`;

        try {
            await this.sock.sendMessage(owner, { text: message });
            this.stats.messagesSent++;
        } catch (error) {
            logger.error('Failed to send startup message:', error);
            this.stats.errors++;
        }
    }

    async sendMessage(jid, content) {
        if (!this.sock) throw new Error('WhatsApp socket not initialized.');
        const result = await this.sock.sendMessage(jid, content);
        this.stats.messagesSent++;
        return result;
    }

    getStats() {
        return {
            ...this.stats,
            uptime: Date.now() - this.startTime.getTime(),
            startTime: this.startTime,
            loadedModules: this.moduleLoader.listModules(),
            isConnected: !!this.sock?.user
        };
    }

    getModuleInstance(name) {
        return this.moduleLoader.getModule(name);
    }

    async shutdown() {
        logger.info('🛑 Shutting down NexusWA...');
        this.isShuttingDown = true;

        for (const name of this.moduleLoader.listModules()) {
            const mod = this.moduleLoader.getModule(name);
            try {
                if (mod?.shutdown) await mod.shutdown();
            } catch (err) {
                logger.error(`Error shutting down module ${name}:`, err);
            }
        }

        if (this.sock) {
            await this.sock.end();
        }

        logger.info('✅ NexusWA shutdown complete.');
    }
}

module.exports = { NexusWA };
