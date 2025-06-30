const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

/**
 * Module Manager for NexusWA
 * Loads and validates modules from modules/ and modules/custom/
 */
class ModuleManager {
    constructor(bot) {
        this.bot = bot;
        this.modules = new Map();
        this.commands = new Map();
        this.systemModulesPath = path.join(__dirname, '../modules');
        this.customModulesPath = path.join(__dirname, '../modules/custom');
        this.systemCount = 0;
        this.customCount = 0;
    }

    /**
     * Initialize and load all modules
     */
    async initialize() {
        logger.info('📦 Loading modules...');
        
        try {
            // Ensure directories exist
            await fs.ensureDir(this.systemModulesPath);
            await fs.ensureDir(this.customModulesPath);
            
            // Load system modules
            this.systemCount = await this.loadModulesFromPath(this.systemModulesPath, 'system');
            
            // Load custom modules
            this.customCount = await this.loadModulesFromPath(this.customModulesPath, 'custom');
            
            logger.info(`✅ Module loading complete:`);
            logger.info(`   • System modules: ${this.systemCount}`);
            logger.info(`   • Custom modules: ${this.customCount}`);
            logger.info(`   • Total modules: ${this.systemCount + this.customCount}`);
            
        } catch (error) {
            logger.error('❌ Failed to load modules:', error);
        }
    }

    /**
     * Load modules from a specific path
     */
    async loadModulesFromPath(modulePath, type) {
        let loadedCount = 0;
        
        try {
            const files = await fs.readdir(modulePath);
            
            for (const file of files) {
                if (file.endsWith('.js')) {
                    const fullPath = path.join(modulePath, file);
                    const success = await this.loadModule(fullPath, type);
                    if (success) loadedCount++;
                }
            }
        } catch (error) {
            logger.debug(`Could not read directory ${modulePath}:`, error.message);
        }
        
        return loadedCount;
    }

    /**
     * Load and validate a single module
     */
    async loadModule(modulePath, type) {
        try {
            const moduleId = path.basename(modulePath, '.js');
            
            // Skip if already loaded
            if (this.modules.has(moduleId)) {
                return false;
            }
            
            // Clear require cache for hot reloading
            delete require.cache[require.resolve(modulePath)];
            
            const moduleData = require(modulePath);
            
            // Validate module structure
            const validation = this.validateModuleStructure(moduleData, moduleId);
            if (!validation.valid) {
                logger.warn(`⚠️ Invalid module structure: ${moduleId}`);
                logger.warn(`   Missing: ${validation.missing.join(', ')}`);
                this.showRequiredStructure();
                return false;
            }
            
            // Register commands
            if (moduleData.commands) {
                for (const command of moduleData.commands) {
                    if (command.name) {
                        this.commands.set(command.name, {
                            ...command,
                            module: moduleData.name
                        });
                    }
                }
            }
            
            this.modules.set(moduleId, {
                ...moduleData,
                type,
                loaded: new Date()
            });
            
            logger.info(`✅ Loaded ${type} module: ${moduleData.name} v${moduleData.version}`);
            return true;
            
        } catch (error) {
            logger.error(`❌ Failed to load module ${modulePath}:`, error.message);
            return false;
        }
    }

    /**
     * Validate module structure
     */
    validateModuleStructure(moduleData, moduleId) {
        const required = ['name', 'version', 'description', 'commands'];
        const missing = [];
        
        for (const field of required) {
            if (!moduleData[field]) {
                missing.push(field);
            }
        }
        
        // Check commands structure
        if (moduleData.commands && Array.isArray(moduleData.commands)) {
            for (const command of moduleData.commands) {
                if (!command.name || !command.description || !command.usage || !command.execute) {
                    missing.push('commands[].{name|description|usage|execute}');
                    break;
                }
            }
        }
        
        return {
            valid: missing.length === 0,
            missing
        };
    }

    /**
     * Show required module structure
     */
    showRequiredStructure() {
        logger.info(`📋 Required module structure:`);
        logger.info(`   {`);
        logger.info(`     name: 'Module Name',`);
        logger.info(`     version: '1.0.0',`);
        logger.info(`     description: 'Module description',`);
        logger.info(`     commands: [`);
        logger.info(`       {`);
        logger.info(`         name: 'command',`);
        logger.info(`         description: 'Command description',`);
        logger.info(`         usage: 'prefix + command [args]',`);
        logger.info(`         execute: async (message, args, context) => {}`);
        logger.info(`       }`);
        logger.info(`     ]`);
        logger.info(`   }`);
    }

    /**
     * Get command handler
     */
    getCommand(commandName) {
        return this.commands.get(commandName);
    }

    /**
     * Get module statistics
     */
    getModuleStats() {
        return {
            system: this.systemCount,
            custom: this.customCount,
            total: this.systemCount + this.customCount
        };
    }

    /**
     * Get all loaded modules
     */
    getModules() {
        return Array.from(this.modules.values());
    }

    /**
     * Get all commands
     */
    getCommands() {
        return Array.from(this.commands.values());
    }
}

module.exports = ModuleManager;
