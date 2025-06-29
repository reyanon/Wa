const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.isShuttingDown = false;
        this.loadedModules = new Map();
        this.startTime = new Date();
        this.stats = {
            messagesReceived: 0,
            messagesSent: 0,
            commandsExecuted: 0,
            errors: 0
        };
    }

    async initialize() {
        logger.info('🔧 Initializing Advanced WhatsApp Bot...');
        
        // Load modules
        await this.loadModules();
        
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
                if (file.endsWith('.js') && !file.includes('telegram-bridge-bot')) {
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

            // Register message hooks
            if (moduleInstance.messageHooks) {
                for (const [hookName, handler] of Object.entries(moduleInstance.messageHooks)) {
                    this.messageHandler.registerMessageHook(hookName, handler.bind(moduleInstance));
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
            (module.commands || module.messageHooks)
        );
    }

    async startWhatsApp() {
        // Clear auth if corrupted
        if (config.get('bot.clearAuthOnStart', false)) {
            try {
                await fs.remove(this.authPath);
                logger.info('🧹 Cleared authentication data');
            } catch (error) {
                logger.debug('No auth data to clear');
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            logger: logger.child({ module: 'baileys' }),
            getMessage: async (key) => ({ conversation: 'Message not found' }),
            generateHighQualityLinkPreview: true,
            markOnlineOnConnect: false
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
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', async (m) => {
            this.stats.messagesReceived += m.messages.length;
            await this.messageHandler.handleMessages(m);
        });

        // Handle call events
        this.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                await this.messageHandler.triggerMessageHooks('call_received', { call });
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
        
        // Trigger connection hooks
        await this.messageHandler.triggerMessageHooks('whatsapp_connected', { 
            user: this.sock.user 
        });
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const modulesList = Array.from(this.loadedModules.keys()).join(', ');
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *System Status:*\n` +
                              `• 📱 WhatsApp: Connected\n` +
                              `• 🔧 Modules: ${this.loadedModules.size} loaded\n` +
                              `• 📦 Active Modules: ${modulesList}\n` +
                              `• 🛡️ Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n` +
                              `• 👀 Auto View Status: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n\n` +
                              `Type *${config.get('bot.prefix')}menu* to see all commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            this.stats.messagesSent++;
        } catch (error) {
            logger.error('Failed to send startup message:', error);
            this.stats.errors++;
        }
    }

    async sendMessage(jid, content) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        const result = await this.sock.sendMessage(jid, content);
        this.stats.messagesSent++;
        return result;
    }

    getStats() {
        return {
            ...this.stats,
            uptime: Date.now() - this.startTime.getTime(),
            startTime: this.startTime,
            loadedModules: Array.from(this.loadedModules.keys()),
            isConnected: !!this.sock?.user
        };
    }

    getModuleInstance(moduleName) {
        const module = this.loadedModules.get(moduleName);
        return module ? module.instance : null;
    }

    async shutdown() {
        logger.info('🛑 Shutting down bot...');
        this.isShuttingDown = true;
        
        // Shutdown all modules
        for (const [name, module] of this.loadedModules) {
            try {
                if (module.instance.shutdown) {
                    await module.instance.shutdown();
                }
            } catch (error) {
                logger.error(`Error shutting down module ${name}:`, error);
            }
        }
        
        if (this.sock) {
            await this.sock.logout();
        }
        
        logger.info('✅ Bot shutdown complete');
    }
}

module.exports = { AdvancedWhatsAppBot };
