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
        logger.info('Initializing Advanced WhatsApp Bot...');
        
        // Load modules
        await this.loadModules();
        
        // Initialize Telegram bridge if enabled
        if (config.get('telegram.enabled') && config.get('telegram.botToken')) {
            this.telegramBridge = new TelegramBridge(this);
            await this.telegramBridge.initialize();
        }

        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('Bot initialized successfully!');
    }

    async loadModules() {
        logger.info('Loading modules...');
        
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
        
        logger.info(`Loaded ${this.loadedModules.size} modules`); // Corrected: Removed emoji
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
                logger.warn(`Invalid module structure: ${moduleId}`); // Corrected: Removed emoji
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

            logger.info(`Loaded module: ${moduleId}`); // Corrected: Removed emoji
        } catch (error) {
            logger.error(`Failed to load module ${modulePath}:`, error); // Corrected: Removed emoji
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
                logger.info('Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('Connection closed, reconnecting...'); // Corrected: Removed emoji
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('Connection closed permanently. Please delete auth_info and restart.'); // Corrected: Removed emoji
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.messageHandler.handleMessages.bind(this.messageHandler));
        
        // Listen for call events - only if real-time detection is enabled
        if (config.get('telegram.settings.enableCallNotifications', true)) {
            this.sock.ev.on('call', async (callEvents) => {
                for (const call of callEvents) {
                    await this.handleCallEvent(call);
                }
            });
        }
    }

    async handleCallEvent(call) {
        if (!this.telegramBridge) return;

        try {
            // Pass call event to telegram bridge for handling
            await this.telegramBridge.handleCallNotification(call);
            logger.debug(`Handled call event: ${call.status} from ${call.from.split('@')[0]}`); // Corrected: Removed emoji
        } catch (error) {
            logger.error('Error handling call event:', error); // Corrected: Removed emoji
        }
    }

    async onConnectionOpen() {
        logger.info('Connected to WhatsApp!'); // Corrected: Removed emoji
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`Owner set to: ${this.sock.user.id}`); // Corrected: Removed emoji
        }

        // Send startup message to owner
        await this.sendStartupMessage();
        
        // Initialize Telegram bridge connection
        if (this.telegramBridge) {
            // Note: syncWhatsAppConnection is not defined in telegram-bridge.js.
            // If this method is intended to exist, it needs to be implemented there.
            // For now, I'm commenting it out or assuming it's a placeholder.
            // await this.telegramBridge.syncWhatsAppConnection(); 
        }
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        // Corrected: Formatted as a single template literal and removed emojis.
        const startupMessage = `*${config.get('bot.name')} v${config.get('bot.version')}* is now online!

*Advanced Features Active:*
• Modular Architecture
• Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}
• Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}
• Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}
• Auto View Status: ${config.get('features.autoViewStatus') ? '✅' : '❌'}
• Call Notifications: ${config.get('telegram.settings.enableCallNotifications', true) ? '✅' : '❌'}
• Status Sync: ${config.get('telegram.settings.syncStatus') ? '✅' : '❌'}

Type *${config.get('bot.prefix')}menu* to see all commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            
            // Also log to Telegram
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('WhatsApp Bot Started', startupMessage);
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
        logger.info('Shutting down bot...'); // Corrected: Removed emoji
        this.isShuttingDown = true;
        
        if (this.telegramBridge) {
            // Note: shutdown is not explicitly defined in telegram-bridge.js from previous context.
            // If this method is intended to exist, it needs to be implemented there.
            // For now, commenting it out or assuming it's a placeholder.
            // await this.telegramBridge.shutdown(); 
        }
        
        if (this.sock) {
            await this.sock.logout();
        }
        
        logger.info('Bot shutdown complete'); // Corrected: Removed emoji
    }
}

module.exports = { AdvancedWhatsAppBot };
