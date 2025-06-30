const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger'); // Adjusted path based on typical project structure

class ModuleLoader {
    constructor(bot) {
        this.bot = bot;
        this.modules = new Map();
        this.systemModulesCount = 0;
        this.customModulesCount = 0;
    }

    async loadModules() {
        const systemPath = path.join(__dirname, '../modules');
        const customPath = path.join(__dirname, '../custom_modules'); // Assuming this is the custom modules folder

        await fs.ensureDir(systemPath);
        await fs.ensureDir(customPath);

        const [systemFiles, customFiles] = await Promise.all([
            fs.readdir(systemPath),
            fs.readdir(customPath)
        ]);

        this.systemModulesCount = 0; // Reset counts for fresh load
        this.customModulesCount = 0; // Reset counts for fresh load

        for (const file of systemFiles) {
            if (file.endsWith('.js')) {
                await this.loadModule(path.join(systemPath, file), true);
            }
        }

        for (const file of customFiles) {
            if (file.endsWith('.js')) {
                await this.loadModule(path.join(customPath, file), false);
            }
        }

        logger.info(`✅ Loaded ${this.systemModulesCount} System Modules.`);
        logger.info(`✅ Loaded ${this.customModulesCount} Custom Modules.`);
        logger.info(`✅ Total Modules Loaded: ${this.systemModulesCount + this.customModulesCount}`);
    }

    async loadModule(filePath, isSystem) {
        const moduleId = path.basename(filePath, '.js');

        try {
            delete require.cache[require.resolve(filePath)];
            const mod = require(filePath);

            // If the module exports a class, instantiate it. Otherwise, assume it's a direct object.
            const moduleInstance = typeof mod === 'function' && /^\s*class\s/.test(mod.toString()) 
                                   ? new mod(this.bot) 
                                   : mod;

            // Use module's own name if available, for better logging
            const actualModuleId = (moduleInstance && moduleInstance.name) ? moduleInstance.name : moduleId;

            // Initialize module if it has an init method
            if (moduleInstance.init && typeof moduleInstance.init === 'function') {
                await moduleInstance.init();
            }

            // Register commands if they exist and are an array
            if (Array.isArray(moduleInstance.commands)) {
                for (const cmd of moduleInstance.commands) {
                    this.bot.messageHandler.registerCommandHandler(cmd.name, cmd);
                }
            }

            // Register messageHooks if they exist and are an object
            if (moduleInstance.messageHooks && typeof moduleInstance.messageHooks === 'object' && moduleInstance.messageHooks !== null) {
                for (const [hook, fn] of Object.entries(moduleInstance.messageHooks)) {
                    this.bot.messageHandler.registerMessageHook(hook, fn.bind(moduleInstance));
                }
            }

            this.modules.set(actualModuleId, {
                instance: moduleInstance,
                path: filePath,
                isSystem
            });

            if (isSystem) {
                this.systemModulesCount++;
            } else {
                this.customModulesCount++;
            }

            logger.info(`✅ Loaded ${isSystem ? 'System' : 'Custom'} module: ${actualModuleId}`);
        } catch (err) {
            logger.error(`❌ Failed to load module '${moduleId}' from ${filePath}:`, err);
        }
    }

    // Removed checkModuleStructure as requested

    getModule(name) {
        return this.modules.get(name)?.instance || null;
    }

    listModules() {
        return [...this.modules.keys()];
    }

    async unloadModule(moduleId) {
        const moduleInfo = this.modules.get(moduleId);
        if (!moduleInfo) {
            throw new Error(`Module ${moduleId} not found`);
        }

        // Call destroy method if it exists for cleanup
        if (moduleInfo.instance.destroy && typeof moduleInfo.instance.destroy === 'function') {
            await moduleInfo.instance.destroy();
        }

        // Unregister commands/hooks (you might need more sophisticated unregistration in messageHandler)
        if (Array.isArray(moduleInfo.instance.commands)) {
            for (const cmd of moduleInfo.instance.commands) {
                if (cmd.name) { // Basic check for command name
                    this.bot.messageHandler.unregisterCommandHandler(cmd.name); // Assuming this method exists
                }
            }
        }
        if (moduleInfo.instance.messageHooks && typeof moduleInfo.instance.messageHooks === 'object') {
            for (const hook of Object.keys(moduleInfo.instance.messageHooks)) {
                this.bot.messageHandler.unregisterMessageHook(hook); // Assuming this method exists
            }
        }

        this.modules.delete(moduleId);
        delete require.cache[moduleInfo.path];
        logger.info(`🚫 Unloaded module: ${moduleId}`);
    }

    async reloadModule(moduleId) {
        const moduleInfo = this.modules.get(moduleId);
        if (!moduleInfo) {
            throw new Error(`Module ${moduleId} not found for reloading`);
        }
        
        logger.info(`🔄 Reloading module: ${moduleId}`);
        await this.unloadModule(moduleId); // Unload first
        await this.loadModule(moduleInfo.path, moduleInfo.isSystem); // Then load again
        logger.info(`✅ Reloaded module: ${moduleId}`);
    }
}

module.exports = ModuleLoader;
