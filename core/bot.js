const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const TelegramBridge = require('../modules/telegram-bridge');
const MongoAuthState = require('./mongo-auth-state');
const db = require('./database');

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.loadedModules = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.mongoAuthState = new MongoAuthState('main_session');
    }

    async initialize() {
        logger.info('🔧 Initializing Advanced WhatsApp Bot...');
        
        try {
            // Initialize database connection
            await this.initializeDatabase();
            
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
        } catch (error) {
            logger.error('❌ Failed to initialize bot:', error);
            throw error;
        }
    }

    async initializeDatabase() {
        logger.info('🗄️ Initializing database connection...');
        
        try {
            const connected = await db.connect();
            if (!connected) {
                logger.warn('⚠️ Database connection failed, using fallback mode');
                return false;
            }
            
            // Initialize auth state manager
            await this.mongoAuthState.init();
            
            logger.info('✅ Database initialized successfully');
            return true;
        } catch (error) {
            logger.error('❌ Database initialization failed:', error);
            logger.warn('⚠️ Continuing without database, using file-based auth');
            return false;
        }
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
        try {
            logger.info('🚀 Starting WhatsApp connection...');
            
            let authState;
            
            // Try to use MongoDB auth state first
            if (db.isConnected) {
                logger.info('📱 Loading session from MongoDB...');
                authState = await this.mongoAuthState.loadSession();
            } else {
                // Fallback to file-based auth
                logger.info('📁 Loading session from files...');
                authState = await this.getFileBasedAuthState();
            }

            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                auth: authState.state,
                version,
                printQRInTerminal: false,
                logger: logger.child({ module: 'baileys' }),
                getMessage: async (key) => ({ conversation: 'Message not found' }),
                generateHighQualityLinkPreview: true,
                syncFullHistory: false,
                markOnlineOnConnect: true
            });

            this.setupEventHandlers(authState.saveCreds);
            
        } catch (error) {
            logger.error('❌ Failed to start WhatsApp:', error);
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                logger.info(`🔄 Retrying connection (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                
                // Clear corrupted session if needed
                if (error.message.includes('session') || error.message.includes('auth')) {
                    await this.handleCorruptedSession();
                }
                
                setTimeout(() => this.startWhatsApp(), 5000 * this.reconnectAttempts);
            } else {
                logger.error('❌ Max reconnection attempts reached. Manual intervention required.');
                throw error;
            }
        }
    }

    async getFileBasedAuthState() {
        const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
        return await useMultiFileAuthState(this.authPath);
    }

    async handleCorruptedSession() {
        logger.warn('🧹 Handling corrupted session...');
        
        try {
            // Backup current session if using MongoDB
            if (db.isConnected) {
                const backupKey = await this.mongoAuthState.backupSession();
                if (backupKey) {
                    logger.info(`💾 Session backed up as: ${backupKey}`);
                }
                
                // Clear corrupted MongoDB session
                await this.mongoAuthState.clearSession();
                logger.info('🗑️ Corrupted MongoDB session cleared');
            }
            
            // Also clear file-based session
            if (await fs.pathExists(this.authPath)) {
                await fs.remove(this.authPath);
                logger.info('🗑️ File-based session cleared');
            }
            
        } catch (error) {
            logger.error('Error handling corrupted session:', error);
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                logger.info('📱 Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
                
                // Log QR to Telegram if bridge is active
                if (this.telegramBridge) {
                    await this.telegramBridge.logToTelegram('📱 QR Code Generated', 
                        'New QR code generated for WhatsApp authentication');
                }
            }
            
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                
                logger.warn(`🔌 Connection closed. Reason: ${this.getDisconnectReason(reason)}`);
                
                if (shouldReconnect && !this.isShuttingDown) {
                    if (reason === DisconnectReason.restartRequired) {
                        logger.info('🔄 Restart required, reinitializing...');
                        this.reconnectAttempts = 0;
                    }
                    
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        logger.info(`🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                        setTimeout(() => this.startWhatsApp(), 5000);
                    } else {
                        logger.error('❌ Max reconnection attempts reached');
                        await this.handleCorruptedSession();
                    }
                } else if (reason === DisconnectReason.loggedOut) {
                    logger.error('❌ Bot was logged out. Clearing session...');
                    await this.handleCorruptedSession();
                }
            } else if (connection === 'open') {
                this.reconnectAttempts = 0;
                await this.onConnectionOpen();
            } else if (connection === 'connecting') {
                logger.info('🔄 Connecting to WhatsApp...');
            }
        });

        this.sock.ev.on('creds.update', async (creds) => {
            await saveCreds();
            
            // Also update MongoDB auth state if available
            if (db.isConnected) {
                await this.mongoAuthState.updateAuthState({ creds });
            }
        });

        this.sock.ev.on('messages.upsert', this.messageHandler.handleMessages.bind(this.messageHandler));
        
        // Handle connection errors
        this.sock.ev.on('connection.update', (update) => {
            if (update.lastDisconnect?.error) {
                logger.error('Connection error:', update.lastDisconnect.error);
            }
        });
    }

    getDisconnectReason(reason) {
        const reasons = {
            [DisconnectReason.badSession]: 'Bad Session',
            [DisconnectReason.connectionClosed]: 'Connection Closed',
            [DisconnectReason.connectionLost]: 'Connection Lost',
            [DisconnectReason.connectionReplaced]: 'Connection Replaced',
            [DisconnectReason.loggedOut]: 'Logged Out',
            [DisconnectReason.multideviceMismatch]: 'Multidevice Mismatch',
            [DisconnectReason.forbidden]: 'Forbidden',
            [DisconnectReason.restartRequired]: 'Restart Required',
            [DisconnectReason.unavailableService]: 'Service Unavailable'
        };
        
        return reasons[reason] || `Unknown (${reason})`;
    }

    async onConnectionOpen() {
        logger.info('✅ Connected to WhatsApp!');
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        // Save successful connection info to database
        if (db.isConnected) {
            await db.saveBotData('last_successful_connection', {
                timestamp: new Date(),
                userId: this.sock.user?.id,
                userJid: this.sock.user?.jid
            });
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

        const dbStatus = db.isConnected ? '✅ Connected' : '❌ Disconnected';
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *Advanced Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🗄️ MongoDB Database: ${dbStatus}\n` +
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

    async getSessionInfo() {
        const info = {
            connected: !!this.sock?.user,
            user: this.sock?.user || null,
            reconnectAttempts: this.reconnectAttempts,
            database: {
                connected: db.isConnected,
                stats: await db.getStats()
            }
        };

        if (db.isConnected) {
            info.sessionData = await this.mongoAuthState.getSessionInfo();
        }

        return info;
    }

    async shutdown() {
        logger.info('🛑 Shutting down bot...');
        this.isShuttingDown = true;
        
        try {
            if (this.telegramBridge) {
                await this.telegramBridge.shutdown();
            }
            
            if (this.sock) {
                await this.sock.logout();
            }
            
            // Close database connection
            if (db.isConnected) {
                await db.disconnect();
            }
            
            logger.info('✅ Bot shutdown complete');
        } catch (error) {
            logger.error('Error during shutdown:', error);
        }
    }
}

module.exports = { AdvancedWhatsAppBot };
