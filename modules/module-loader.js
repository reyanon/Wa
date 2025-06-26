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
                    this.bot.messageHandler.registerCommandHandler(command.name, command);
                }
            }

            this.loadedModules.set(moduleId, {
                instance: moduleInstance,
                type,
                path: modulePath,
                loaded: new Date()
            });

            logger.info(`✅ Loaded ${type} module: ${moduleId}`);
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

    async reloadModule(moduleId) {
        const moduleInfo = this.loadedModules.get(moduleId);
        if (!moduleInfo) {
            throw new Error(`Module ${moduleId} not found`);
        }

        // Unload module
        if (moduleInfo.instance.destroy) {
            await moduleInfo.instance.destroy();
        }

        // Reload module
        await this.loadModule(moduleInfo.path, moduleInfo.type);
        logger.info(`🔄 Reloaded module: ${moduleId}`);
    }

    getLoadedModules() {
        return Array.from(this.loadedModules.entries()).map(([id, info]) => ({
            id,
            name: info.instance.name,
            version: info.instance.version,
            type: info.type,
            loaded: info.loaded
        }));
    }
}

module.exports = ModuleLoader;
