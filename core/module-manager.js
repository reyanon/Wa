const fs = require("fs");
const path = require("path");
const logger = require("./logger");

class ModuleManager {

    constructor(bot) {
        this.bot = bot;
        this.modules = new Map();
    }

    /**
     * Load all modules from built-in + custom folders
     */
async loadModules() {
    const modulesPath = path.join(__dirname, "../modules");
    const customModulesPath = path.join(modulesPath, "custom");

    await fs.promises.mkdir(modulesPath, { recursive: true });
    await fs.promises.mkdir(customModulesPath, { recursive: true });

    const builtins = await fs.promises.readdir(modulesPath);
    const customs = await fs.promises.readdir(customModulesPath);

    const allFiles = [
        ...builtins.filter(f => f.endsWith(".js")),
        ...customs.filter(f => f.endsWith(".js")).map(f => "custom/" + f)
    ];

    let total = allFiles.length;
    let success = 0;
    let failed = 0;
    let failedModules = [];

    for (const file of allFiles) {
        try {
            const modulePath = path.join(modulesPath, file);

            delete require.cache[require.resolve(modulePath)];

            const ModuleClass = require(modulePath);
            const mod = new ModuleClass(this.bot);

            if (!this.validateModule(mod)) {
                logger.warn(`⚠️ Invalid module contract: ${file}`);
                failedModules.push(file);
                failed++;
                continue;
            }

            if (mod.init) await mod.init();

            if (mod.commands) {
                for (const cmd of mod.commands) {
                    this.bot.messageHandler.registerCommandHandler(cmd.name, cmd);
                }
            }

            if (mod.messageHooks) {
                for (const [hook, handler] of Object.entries(mod.messageHooks)) {
                    this.bot.messageHandler.registerMessageHook(hook, handler.bind(mod));
                }
            }

            this.modules.set(mod.name, mod);
            logger.info(`✅ Loaded module: ${mod.name} v${mod.version}`);
            success++;

        } catch (err) {
            logger.error(`❌ Failed to load module ${file}:`, err);
            failedModules.push(file);
            failed++;
        }
    }

    if (failed > 0) {
        logger.warn(`⚠️ Failed modules: ${failedModules.join(", ")}`);
    }

    logger.info(
        `📦 Module scan finished: total=${total}, loaded=${success}, failed=${failed}`
    );
}

    /**
     * Validate the plugin contract
     */
    validateModule(mod) {
        return (
            mod &&
            typeof mod === "object" &&
            mod.name &&
            mod.version &&
            mod.commands
        );
    }

    /**
     * Get a module instance by name
     */
    getModule(name) {
        return this.modules.get(name);
    }

    /**
     * List all loaded module names
     */
    listModules() {
        return Array.from(this.modules.keys());
    }
}

module.exports = ModuleManager;
