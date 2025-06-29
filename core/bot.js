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
        
        // Generate module loading report
        this.generateModuleReport();
        
        logger.info(`✅ Loaded ${this.loadedModules.size} modules`);
    }

    async loadModule(modulePath) {
        try {
            const moduleId = path.basename(modulePath, '.js');
            
            // Clear require cache for hot reloading
            delete require.cache[require.resolve(modulePath)];
            
            const ModuleClass = require(modulePath);
            const moduleInstance = new ModuleClass(this);
            
            // Check module validity and report issues
            const validationResult = this.validateModuleWithDetails(moduleInstance);
            
            if (!validationResult.isValid) {
                logger.warn(`⚠️ Loading INVALID module: ${moduleId}`);
                logger.warn(`📋 Missing/Invalid properties:`);
                validationResult.issues.forEach(issue => {
                    logger.warn(`   • ${issue}`);
                });
                logger.warn(`🔧 Attempting to load anyway...`);
            }

            // Initialize module (even if invalid)
            try {
                if (moduleInstance.init && typeof moduleInstance.init === 'function') {
                    await moduleInstance.init();
                } else if (moduleInstance.init) {
                    logger.warn(`   • init property exists but is not a function`);
                }
            } catch (initError) {
                logger.warn(`⚠️ Module init failed for ${moduleId}:`, initError.message);
            }

            // Register commands (even if module is invalid)
            let commandsRegistered = 0;
            try {
                if (moduleInstance.commands && Array.isArray(moduleInstance.commands)) {
                    for (const command of moduleInstance.commands) {
                        if (command && command.name) {
                            this.messageHandler.registerCommandHandler(command.name, command);
                            commandsRegistered++;
                        } else {
                            logger.warn(`   • Invalid command found (missing name property)`);
                        }
                    }
                } else if (moduleInstance.commands) {
                    logger.warn(`   • commands property exists but is not an array`);
                }
            } catch (commandError) {
                logger.warn(`⚠️ Command registration failed for ${moduleId}:`, commandError.message);
            }

            // Store module info with validation status
            this.loadedModules.set(moduleId, {
                instance: moduleInstance,
                path: modulePath,
                loaded: new Date(),
                isValid: validationResult.isValid,
                issues: validationResult.issues,
                commandsRegistered
            });

            if (validationResult.isValid) {
                logger.info(`✅ Loaded module: ${moduleId} (${commandsRegistered} commands)`);
            } else {
                logger.info(`⚠️ Loaded INVALID module: ${moduleId} (${commandsRegistered} commands) - Check warnings above`);
            }
        } catch (error) {
            logger.error(`❌ Failed to load module ${modulePath}:`, error);
            
            // Still try to track the failed module
            const moduleId = path.basename(modulePath, '.js');
            this.loadedModules.set(moduleId, {
                instance: null,
                path: modulePath,
                loaded: new Date(),
                isValid: false,
                issues: [`Failed to load: ${error.message}`],
                commandsRegistered: 0,
                loadError: error
            });
        }
    }

    validateModuleWithDetails(module) {
        const issues = [];
        let isValid = true;

        // Check if module exists and is an object
        if (!module) {
            issues.push('Module is null or undefined');
            return { isValid: false, issues };
        }

        if (typeof module !== 'object') {
            issues.push('Module is not an object');
            return { isValid: false, issues };
        }

        // Check required properties
        if (!module.name) {
            issues.push('Missing "name" property');
            isValid = false;
        } else if (typeof module.name !== 'string') {
            issues.push('"name" property is not a string');
            isValid = false;
        }

        if (!module.version) {
            issues.push('Missing "version" property');
            isValid = false;
        } else if (typeof module.version !== 'string') {
            issues.push('"version" property is not a string');
            isValid = false;
        }

        // Check if module has either commands or handlers
        const hasCommands = module.commands && Array.isArray(module.commands) && module.commands.length > 0;
        const hasHandlers = module.handlers && (Array.isArray(module.handlers) || typeof module.handlers === 'object');

        if (!hasCommands && !hasHandlers) {
            issues.push('Missing both "commands" and "handlers" properties (at least one is required)');
            isValid = false;
        }

        // Validate commands if they exist
        if (module.commands) {
            if (!Array.isArray(module.commands)) {
                issues.push('"commands" property is not an array');
                isValid = false;
            } else {
                module.commands.forEach((command, index) => {
                    if (!command || typeof command !== 'object') {
                        issues.push(`Command at index ${index} is not an object`);
                        isValid = false;
                    } else if (!command.name) {
                        issues.push(`Command at index ${index} is missing "name" property`);
                        isValid = false;
                    }
                });
            }
        }

        // Additional helpful checks
        if (module.description && typeof module.description !== 'string') {
            issues.push('"description" property exists but is not a string');
        }

        if (module.author && typeof module.author !== 'string') {
            issues.push('"author" property exists but is not a string');
        }

        return { isValid, issues };
    }

    // Legacy method for backward compatibility
    validateModule(module) {
        return this.validateModuleWithDetails(module).isValid;
    }

    generateModuleReport() {
        const modules = Array.from(this.loadedModules.entries());
        const validModules = modules.filter(([_, info]) => info.isValid);
        const invalidModules = modules.filter(([_, info]) => !info.isValid);
        const totalCommands = modules.reduce((sum, [_, info]) => sum + (info.commandsRegistered || 0), 0);

        logger.info('📊 Module Loading Report:');
        logger.info(`   Total Modules: ${modules.length}`);
        logger.info(`   Valid Modules: ${validModules.length}`);
        logger.info(`   Invalid Modules: ${invalidModules.length}`);
        logger.info(`   Total Commands: ${totalCommands}`);

        if (invalidModules.length > 0) {
            logger.warn('⚠️ Invalid Modules Summary:');
            invalidModules.forEach(([id, info]) => {
                logger.warn(`   • ${id}: ${info.issues?.length || 0} issues`);
            });
        }
    }

    getModuleValidationReport() {
        const modules = Array.from(this.loadedModules.entries()).map(([id, info]) => ({
            id,
            name: info.instance?.name || 'Unknown',
            version: info.instance?.version || 'Unknown',
            loaded: info.loaded,
            isValid: info.isValid,
            issues: info.issues || [],
            commandsRegistered: info.commandsRegistered || 0,
            hasLoadError: !!info.loadError
        }));

        const validModules = modules.filter(m => m.isValid);
        const invalidModules = modules.filter(m => !m.isValid);

        return {
            total: modules.length,
            valid: validModules.length,
            invalid: invalidModules.length,
            validModules,
            invalidModules
        };
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

        const moduleReport = this.getModuleValidationReport();
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *Advanced Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🛡️ Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n` +
                              `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                              `• 👀 Auto View Status: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n\n` +
                              `📊 *Module Status:*\n` +
                              `• Total: ${moduleReport.total}\n` +
                              `• Valid: ${moduleReport.valid}\n` +
                              `• Invalid: ${moduleReport.invalid}\n\n` +
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
