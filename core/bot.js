const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger'); // Assuming logger.js is in the same directory as this file
const MessageHandler = require('./message-handler'); // Assuming message-handler.js is in the same directory
const TelegramBridge = require('./bridge'); // Assuming bridge.js is in the same directory
const { connectDb, closeDb } = require('./db'); // Import connectDb and closeDb from db.js (assuming it's relative to this file)

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.loadedModules = new Map();
        this.db = null; // Property to hold the centralized database connection
    }

    async initialize() {
        logger.info('🔧 Initializing Advanced WhatsApp Bot...');
        
        // --- CENTRALIZED DATABASE CONNECTION (FIXED) ---
        // Connect to the database once at the application's main entry point
        try {
            this.db = await connectDb(); // This connectDb should handle singleton logic
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            // Decide how to handle a failed DB connection (e.g., exit, continue without DB features)
            process.exit(1); // Exit if DB connection is critical for your bot
        }
        // --- END CENTRALIZED DATABASE CONNECTION ---

        // Load modules
        await this.loadModules();
        
        // Initialize Telegram bridge if enabled, passing the shared database instance (FIXED)
        if (config.get('telegram.enabled') && config.get('telegram.botToken')) {
            this.telegramBridge = new TelegramBridge(this);
            // Pass the pre-connected database instance to the TelegramBridge
            await this.telegramBridge.initialize(this.db); // <<< IMPORTANT CHANGE: Pass this.db
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
            
            // Pass 'this' (the bot instance, which now holds this.db) to the module
            const ModuleClass = require(modulePath);
            const moduleInstance = new ModuleClass(this); 

            // Validate module structure
            if (!this.validateModule(moduleInstance)) {
                logger.warn(`⚠️ Invalid module structure: ${moduleId}`);
                return;
            }

            // Initialize module
            // Modules can now access `this.bot.db` if they need the database
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
            printQRInTerminal: false, // Keep this as false, we'll handle printing manually (FIXED)
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
                // 1. Print QR code to terminal
                qrcode.generate(qr, { small: true }); 

                // 2. Attempt to send QR code to Telegram (FIXED)
                // This ensures it only tries to send if the Telegram bot is initialized
                // and has identified the owner's private chat ID (botChatId).
                if (this.telegramBridge && this.telegramBridge.telegramBot && this.telegramBridge.botChatId) {
                    try {
                        // Generate the QR code as a string to send as text
                        const qrText = qrcode.generate(qr, { small: true, return_value: true }); 
                        await this.telegramBridge.logToTelegram('📱 WhatsApp QR Code', 
                                                                `\`\`\`\n${qrText}\n\`\`\`\nScan this QR code with your WhatsApp app to connect.`);
                        logger.info('✅ QR code sent to Telegram.');
                    } catch (error) {
                        logger.error('❌ Failed to send QR code to Telegram:', error);
                    }
                } else {
                    logger.warn('⚠️ Telegram bridge or botChatId not yet ready to send QR code to Telegram.');
                    logger.warn('Please send a private message (e.g., /start) to your Telegram bot first to enable private notifications.');
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('🔄 Connection closed, reconnecting...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');
                    // Optionally, inform Telegram about permanent disconnect
                    if (this.telegramBridge && this.telegramBridge.telegramBot && this.telegramBridge.botChatId) {
                         await this.telegramBridge.logToTelegram('❌ WhatsApp Disconnected', 'WhatsApp connection closed permanently. Please delete `auth_info` folder and restart the bot.');
                    }
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.messageHandler.handleMessages.bind(this.messageHandler));
    }

    async onConnectionOpen() {
        logger.info('✅ Connected to WhatsApp!');
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        // Send startup message to owner and Telegram (FIXED)
        await this.sendStartupMessage(); // This method already includes Telegram logging
        
        // Initialize Telegram bridge connection for WhatsApp handlers (FIXED)
        // Ensure WhatsApp handlers in TelegramBridge are setup after sock is available.
        // This is crucial for TelegramBridge to react to WhatsApp events.
        if (this.telegramBridge) {
            await this.telegramBridge.syncWhatsAppConnection(); // Sync contacts and other bridge setup
            this.telegramBridge.setupWhatsAppHandlers(); 
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
            
            // Also log to Telegram via the bridge
            if (this.telegramBridge) {
                // This will send to either botChatId (private chat) or telegram.chatId (supergroup)
                // depending on your logToTelegram implementation in TelegramBridge.
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
            // Call the modified shutdown method on TelegramBridge,
            // which now only stops bridging functionality, not the Telegram bot polling itself.
            await this.telegramBridge.shutdown(); 
        }
        
        if (this.sock) {
            await this.sock.end(); // Logout from WhatsApp
        }
        
        // Do NOT close the database connection here directly.
        // It should be handled by the application's main process exit or
        // a dedicated DB disconnect function (like `closeDb()` from `db.js`)
        // called in your main entry point (e.g., index.js or app.js) on process exit.
        await closeDb(); // Call the centralized database close function (FIXED)
        
        logger.info('✅ Bot shutdown complete');
    }
}

module.exports = { AdvancedWhatsAppBot };
