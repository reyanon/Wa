const fs = require('fs-extra');
const path = require('path');
const logger = require('../core/logger');

class ModuleLoader {
    constructor(bot) {
        this.bot = bot;
        this.loadedModules = new Map();
        this.modulesPath = path.join(__dirname, '../modules');
        this.customModulesPath = path.join(this.modulesPath, 'custom-modules');
    }

    async loadModules() {
        logger.info('📦 Loading modules...');
        
        // Ensure directories exist
        await fs.ensureDir(this.modulesPath);
        await fs.ensureDir(this.customModulesPath);

        // Load core modules
        await this.loadCoreModules();
        
        // Load custom modules
        await this.loadCustomModules();
        
        logger.info(`✅ Loaded ${this.loadedModules.size} modules`);
    }

    async loadCoreModules() {
        const coreModuleDirs = [
            'general',
            'fun', 
            'utilities',
            'admin',
            'downloads'
        ];

        for (const dir of coreModuleDirs) {
            const dirPath = path.join(this.modulesPath, dir);
            if (await fs.pathExists(dirPath)) {
                await this.loadModulesFromDirectory(dirPath, 'core');
            }
        }
    }

    async loadCustomModules() {
        if (await fs.pathExists(this.customModulesPath)) {
            await this.loadModulesFromDirectory(this.customModulesPath, 'custom');
        }
    }

    async loadModulesFromDirectory(dirPath, type) {
        try {
            const files = await fs.readdir(dirPath);
            
            for (const file of files) {
                if (file.endsWith('.js')) {
                    await this.loadModule(path.join(dirPath, file), type);
                }
            }
        } catch (error) {
            logger.error(`Error loading modules from ${dirPath}:`, error);
        }
    }

    async loadModule(modulePath, type) {
        try {
            const moduleId = path.basename(modulePath, '.js');
            
            // Clear require cache for hot reloading
            delete require.cache[require.resolve(modulePath)];
            
            const ModuleClass = require(modulePath);
            const moduleInstance = new ModuleClass(this.bot);
            
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
                            this.bot.messageHandler.registerCommandHandler(command.name, command);
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
                type,
                path: modulePath,
                loaded: new Date(),
                isValid: validationResult.isValid,
                issues: validationResult.issues,
                commandsRegistered
            });

            if (validationResult.isValid) {
                logger.info(`✅ Loaded ${type} module: ${moduleId} (${commandsRegistered} commands)`);
            } else {
                logger.info(`⚠️ Loaded INVALID ${type} module: ${moduleId} (${commandsRegistered} commands) - Check warnings above`);
            }
        } catch (error) {
            logger.error(`❌ Failed to load module ${modulePath}:`, error);
            
            // Still try to track the failed module
            const moduleId = path.basename(modulePath, '.js');
            this.loadedModules.set(moduleId, {
                instance: null,
                type,
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

    async reloadModule(moduleId) {
        const moduleInfo = this.loadedModules.get(moduleId);
        if (!moduleInfo) {
            throw new Error(`Module ${moduleId} not found`);
        }

        // Unload module
        if (moduleInfo.instance && moduleInfo.instance.destroy) {
            try {
                await moduleInfo.instance.destroy();
            } catch (error) {
                logger.warn(`Warning during module destroy for ${moduleId}:`, error.message);
            }
        }

        // Reload module
        await this.loadModule(moduleInfo.path, moduleInfo.type);
        logger.info(`🔄 Reloaded module: ${moduleId}`);
    }

    getLoadedModules() {
        return Array.from(this.loadedModules.entries()).map(([id, info]) => ({
            id,
            name: info.instance?.name || 'Unknown',
            version: info.instance?.version || 'Unknown',
            type: info.type,
            loaded: info.loaded,
            isValid: info.isValid,
            issues: info.issues || [],
            commandsRegistered: info.commandsRegistered || 0,
            hasLoadError: !!info.loadError
        }));
    }

    getModuleValidationReport() {
        const modules = this.getLoadedModules();
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
}

module.exports = ModuleLoader;
