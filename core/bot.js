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
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.loadedModules = new Map();
    }

    async initialize() {
        logger.info('🔧 Initializing Advanced WhatsApp Bot...');
        
        // Load modules
        await this.loadModules();
        
        // Initialize Telegram bridge if enabled
        if (config.get('telegram.enabled') && config.get('telegram.botToken')) {
            this.telegramBridge = new TelegramBridge(this);
            await this.telegramBridge.initialize();
        }

        // Start WhatsApp connection
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
                if (file.endsWith('.js')) {
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
            
            // Clear require cache for hot reloading
            delete require.cache[require.resolve(modulePath)];
            
            const ModuleClass = require(modulePath);
            const moduleInstance = new ModuleClass(this);
            
            // Validate module structure
            if (!this.validateModule(moduleInstance)) {
                logger.warn(`⚠️ Invalid module structure: ${moduleId}`);
                return;
            }

            // Initialize module
            if (moduleInstance.init) {
                await moduleInstance.init();
            }

            // Register commands
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
        return (
            module &&
            typeof module === 'object' &&
            module.name &&
            module.version &&
            (module.commands || module.handlers)
        );
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
                // Notify TelegramBridge of connection
                if (this.telegramBridge && this.telegramBridge.messageHooks['whatsapp_connected']) {
                    await this.telegramBridge.messageHooks['whatsapp_connected']();
                }
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        // Handle messages
        this.sock.ev.on('messages.upsert', async (update) => {
            await this.messageHandler.handleMessages(update);
            // Forward to TelegramBridge
            if (this.telegramBridge && this.telegramBridge.messageHooks['message_received']) {
                for (const message of update.messages) {
                    await this.telegramBridge.messageHooks['message_received'](message);
                }
            }
        });

        // Handle message updates (e.g., delivery receipts, read receipts)
        this.sock.ev.on('messages.update', async (updates) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['message_delivery']) {
                for (const update of updates) {
                    await this.telegramBridge.messageHooks['message_delivery'](update);
                }
            }
        });

        // Handle reactions
        this.sock.ev.on('messages.reaction', async (reactions) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['message_reaction']) {
                for (const reaction of reactions) {
                    await this.telegramBridge.messageHooks['message_reaction'](reaction);
                }
            }
        });

        // Handle message revokes
        this.sock.ev.on('messages.delete', async (update) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['message_revoked']) {
                await this.telegramBridge.messageHooks['message_revoked'](update);
            }
        });

        // Handle group updates
        this.sock.ev.on('groups.update', async (updates) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['group_update']) {
                for (const update of updates) {
                    await this.telegramBridge.messageHooks['group_update'](update);
                }
            }
        });

        // Handle group participant updates
        this.sock.ev.on('group-participants.update', async (update) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['group_participants_update']) {
                await this.telegramBridge.messageHooks['group_participants_update'](update);
            }
        });

        // Handle call events
        this.sock.ev.on('call', async (calls) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['call_received']) {
                for (const call of calls) {
                    await this.telegramBridge.messageHooks['call_received'](call);
                }
            }
        });

        // Handle presence updates
        this.sock.ev.on('presence.update', async (update) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['presence_update']) {
                await this.telegramBridge.messageHooks['presence_update'](update);
            }
        });

        // Handle status updates
        this.sock.ev.on('messaging-history.set', async ({ statuses }) => {
            if (this.telegramBridge && this.telegramBridge.messageHooks['status_received']) {
                for (const status of statuses || []) {
                    await this.telegramBridge.messageHooks['status_received'](status);
                }
            }
        });
    }

    async onConnectionOpen() {
        logger.info('✅ Connected to WhatsApp!');
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        // Send startup message to owner
        await this.sendStartupMessage();
        
        // Initialize Telegram bridge connection
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
                              `Type *${config.get('bot.prefix')}menu* to see all commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            
            // Also log to Telegram
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 WhatsApp Bot Started', startupMessage);
            }
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
        
        logger.info('✅ Bot shutdown complete');
    }
}

module.exports = { AdvancedWhatsAppBot };
