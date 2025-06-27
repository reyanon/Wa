// Imports, Constructor, Initialization
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const TelegramBridge = require('../modules/telegram-bridge');

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null;
        this.authPath = path.join(__dirname, '../session');  // safer than ./auth_info
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.loadedModules = new Map();
    }

    async initialize() {
        logger.info('🔧 Initializing Advanced WhatsApp Bot...');

        // Load custom modules
        await this.loadModules();

        // Setup Telegram bridge
        if (config.get('telegram.enabled') && config.get('telegram.botToken')) {
            this.telegramBridge = new TelegramBridge(this);
            await this.telegramBridge.initialize();
        }

        // Connect to WhatsApp
        await this.startWhatsApp();

        logger.info('✅ Bot initialized successfully!');
    }

    async loadModules() {
        logger.info('📦 Loading modules...');
        const modulesPath = path.join(__dirname, '../modules');
        await fs.ensureDir(modulesPath);

        try {
            const files = await fs.readdir(modulesPath);
            for (const file of files) {
                if (file.endsWith('.js') && file !== 'telegram-bridge.js') {
                    await this.loadModule(path.join(modulesPath, file));
                }
            }
        } catch (error) {
            logger.error('Error loading modules:', error);
        }

        logger.info(`✅ Loaded ${this.loadedModules.size} modules`);
    }

    async loadModule(modulePath) {
        try {
            const moduleId = path.basename(modulePath, '.js');
            delete require.cache[require.resolve(modulePath)];
            const ModuleClass = require(modulePath);
            const moduleInstance = new ModuleClass(this);

            if (!this.validateModule(moduleInstance)) {
                logger.warn(`⚠️ Invalid module structure: ${moduleId}`);
                return;
            }

            if (moduleInstance.init) await moduleInstance.init();
            if (moduleInstance.commands) {
                for (const command of moduleInstance.commands) {
                    this.messageHandler.registerCommandHandler(command.name, command);
                }
            }

            this.loadedModules.set(moduleId, {
                instance: moduleInstance,
                path: modulePath,
                loaded: new Date()
            });

            logger.info(`✅ Loaded module: ${moduleId}`);
        } catch (error) {
            logger.error(`❌ Failed to load module ${modulePath}:`, error);
        }
    }

    validateModule(module) {
        return module && typeof module === 'object' && module.name && module.version && (module.commands || module.handlers);
    }

// WhatsApp Connection, Event Setup, Telegram Calls

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
            try {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    logger.info('📱 Scan QR code with WhatsApp:');
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect && !this.isShuttingDown) {
                        logger.warn('🔄 Connection closed, reconnecting...');
                        setTimeout(() => this.startWhatsApp(), 5000);
                    } else {
                        logger.error('❌ Connection closed permanently. Please delete session and restart.');
                    }
                } else if (connection === 'open') {
                    await this.onConnectionOpen();
                }
            } catch (err) {
                logger.error('💥 Error in connection.update:', err);
            }
        });

        this.sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (err) {
                logger.error('💥 Error saving credentials:', err);
            }
        });

        this.sock.ev.on('messages.upsert', async (data) => {
            try {
                await this.messageHandler.handleMessages(data);
            } catch (err) {
                logger.error('💥 Error in messages.upsert handler:', err);
            }
        });

        if (config.get('telegram.settings.enableCallNotifications', true)) {
            this.sock.ev.on('call', async (callEvents) => {
                for (const call of callEvents) {
                    try {
                        await this.handleCallEvent(call);
                    } catch (err) {
                        logger.error('❌ Error handling call:', err);
                    }
                }
            });
        }
    }

    async handleCallEvent(call) {
        if (!this.telegramBridge) return;

        try {
            await this.telegramBridge.handleCallNotification(call);
            logger.debug(`📞 Handled call event: ${call.status} from ${call.from.split('@')[0]}`);
        } catch (error) {
            logger.error('❌ Error handling call event:', error);
        }
    }

    async onConnectionOpen() {
        logger.info('✅ Connected to WhatsApp!');

        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        await this.sendStartupMessage();
    }
// Startup, Messaging, Shutdown, Export

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const startupMessage =
            `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
            `🔥 *Advanced Features Active:*\n` +
            `• 📱 Modular Architecture\n` +
            `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
            `• 🛡️ Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n` +
            `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
            `• 👀 Auto View Status: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n` +
            `• 📞 Call Notifications: ${config.get('telegram.settings.enableCallNotifications', true) ? '✅' : '❌'}\n` +
            `• 📊 Status Sync: ${config.get('telegram.settings.syncStatus') ? '✅' : '❌'}\n\n` +
            `Type *${config.get('bot.prefix')}menu* to see all commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });

            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 WhatsApp Bot Started', startupMessage);
            }
        } catch (error) {
            logger.error('❌ Failed to send startup message:', error);
        }
    }

    async sendMessage(jid, content) {
        if (!this.sock) throw new Error('WhatsApp socket not initialized');
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
        logger.info('🛑 Shutting down bot...');
        this.isShuttingDown = true;

        if (this.telegramBridge) {
            await this.telegramBridge.shutdown();
        }

        // Do NOT logout here – we keep session intact
        logger.info('✅ Bot shutdown complete');
    }
}

module.exports = { AdvancedWhatsAppBot };
