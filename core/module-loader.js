
const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');

class ModuleLoader {
    constructor(bot) {
        this.bot = bot;
        this.modules = new Map();
    }

    async loadModules() {
        const systemPath = path.join(__dirname, '../modules');
        const customPath = path.join(__dirname, '../custom_modules');

        await fs.ensureDir(systemPath);
        await fs.ensureDir(customPath);

        const [systemFiles, customFiles] = await Promise.all([
            fs.readdir(systemPath),
            fs.readdir(customPath)
        ]);

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

        const validCount = [...this.modules.values()].filter(m => m.status === 'valid').length;
        const partialCount = [...this.modules.values()].filter(m => m.status === 'partial').length;

        logger.info(`✅ Loaded ${validCount} valid modules, ${partialCount} partially valid.`);
    }

    async loadModule(filePath, isSystem) {
        const moduleId = path.basename(filePath, '.js');

        try {
            delete require.cache[require.resolve(filePath)];
            const mod = require(filePath);

            if (!mod || typeof mod !== 'object') {
                logger.warn(`❌ ${isSystem ? 'System' : 'Custom'} module '${moduleId}' does not export a valid object.`);
                return;
            }

            const status = this.checkModuleStructure(mod, moduleId, isSystem);

            if (mod.init) await mod.init();
            if (mod.commands) {
                for (const cmd of mod.commands) {
                    this.bot.messageHandler.registerCommandHandler(cmd.name, cmd);
                }
            }
            if (mod.messageHooks) {
                for (const [hook, fn] of Object.entries(mod.messageHooks)) {
                    this.bot.messageHandler.registerMessageHook(hook, fn.bind(mod));
                }
            }

            this.modules.set(moduleId, {
                instance: mod,
                path: filePath,
                isSystem,
                status
            });

            logger.info(`✅ Loaded ${isSystem ? 'System' : 'Custom'} module: ${moduleId} (${status})`);
        } catch (err) {
            logger.error(`❌ Failed to load module '${moduleId}':`, err);
        }
    }

    checkModuleStructure(mod, moduleId, isSystem) {
        const missing = [];
        if (!mod.name) missing.push('name');
        if (!mod.version) missing.push('version');
        if (!mod.commands && !mod.messageHooks) missing.push('commands/messageHooks');

        if (missing.length > 0) {
            logger.warn(`⚠️ ${isSystem ? 'System' : 'Custom'} module '${moduleId}' missing: ${missing.join(', ')}`);
        }

        return missing.length === 0 ? 'valid' : 'partial';
    }

    getModule(name) {
        return this.modules.get(name)?.instance || null;
    }

    listModules() {
        return [...this.modules.keys()];
    }
}

module.exports = ModuleLoader;
