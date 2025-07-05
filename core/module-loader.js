
const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');
const config = require('../config');
const helpers = require('../utils/helpers');

class ModuleLoader {
    constructor(bot) {
        this.bot = bot;
        this.modules = new Map();
        this.systemModulesCount = 0;
        this.customModulesCount = 0;
        this.setupModuleCommands();
    }

    setupModuleCommands() {
        // Load Module Command
        const loadModuleCommand = {
            name: 'lm',
            description: 'Load a module from file',
            usage: '.lm (reply to a .js file)',
            permissions: 'owner',
            execute: async (msg, params, context) => {
                if (!msg.message?.documentMessage?.fileName?.endsWith('.js')) {
                    return context.bot.sendMessage(context.sender, {
                        text: '🔧 *Load Module*\n\n❌ Please reply to a JavaScript (.js) file to load it as a module.'
                    });
                }

                try {
                    const processingMsg = await context.bot.sendMessage(context.sender, {
                        text: '⚡ *Loading Module*\n\n🔄 Downloading and installing module...\n⏳ Please wait...'
                    });

                    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                    const stream = await downloadContentFromMessage(msg.message.documentMessage, 'document');
                    
                    const chunks = [];
                    for await (const chunk of stream) {
                        chunks.push(chunk);
                    }
                    const buffer = Buffer.concat(chunks);
                    
                    const fileName = msg.message.documentMessage.fileName;
                    const customModulesPath = path.join(__dirname, '../custom_modules');
                    await fs.ensureDir(customModulesPath);
                    
                    const filePath = path.join(customModulesPath, fileName);
                    await fs.writeFile(filePath, buffer);
                    
                    await this.loadModule(filePath, false);
                    
                    await context.bot.sock.sendMessage(context.sender, {
                        text: `✅ *Module Loaded Successfully*\n\n📦 Module: \`${fileName}\`\n📁 Location: Custom Modules\n🎯 Status: Active\n⏰ ${new Date().toLocaleTimeString()}`,
                        edit: processingMsg.key
                    });

                } catch (error) {
                    logger.error('Failed to load module:', error);
                    await context.bot.sendMessage(context.sender, {
                        text: `❌ *Module Load Failed*\n\n🚫 Error: ${error.message}\n🔧 Please check the module file format.`
                    });
                }
            }
        };

        // Unload Module Command
        const unloadModuleCommand = {
            name: 'ulm',
            description: 'Unload a module',
            usage: '.ulm <module_name>',
            permissions: 'owner',
            execute: async (msg, params, context) => {
                if (params.length === 0) {
                    const moduleList = this.listModules().join('\n• ');
                    return context.bot.sendMessage(context.sender, {
                        text: `🔧 *Unload Module*\n\n📋 Available modules:\n• ${moduleList}\n\n💡 Usage: \`.ulm <module_name>\``
                    });
                }

                const moduleName = params[0];
                
                try {
                    const processingMsg = await context.bot.sendMessage(context.sender, {
                        text: `⚡ *Unloading Module*\n\n🔄 Removing: \`${moduleName}\`\n⏳ Please wait...`
                    });

                    await this.unloadModule(moduleName);
                    
                    await context.bot.sock.sendMessage(context.sender, {
                        text: `✅ *Module Unloaded Successfully*\n\n📦 Module: \`${moduleName}\`\n🗑️ Status: Removed\n⏰ ${new Date().toLocaleTimeString()}`,
                        edit: processingMsg.key
                    });

                } catch (error) {
                    logger.error('Failed to unload module:', error);
                    await context.bot.sendMessage(context.sender, {
                        text: `❌ *Module Unload Failed*\n\n🚫 Error: ${error.message}\n📦 Module: \`${moduleName}\``
                    });
                }
            }
        };

        // Reload Module Command
        const reloadModuleCommand = {
            name: 'rlm',
            description: 'Reload a module',
            usage: '.rlm <module_name>',
            permissions: 'owner',
            execute: async (msg, params, context) => {
                if (params.length === 0) {
                    const moduleList = this.listModules().join('\n• ');
                    return context.bot.sendMessage(context.sender, {
                        text: `🔧 *Reload Module*\n\n📋 Available modules:\n• ${moduleList}\n\n💡 Usage: \`.rlm <module_name>\``
                    });
                }

                const moduleName = params[0];
                
                try {
                    const processingMsg = await context.bot.sendMessage(context.sender, {
                        text: `⚡ *Reloading Module*\n\n🔄 Restarting: \`${moduleName}\`\n⏳ Please wait...`
                    });

                    await this.reloadModule(moduleName);
                    
                    await context.bot.sock.sendMessage(context.sender, {
                        text: `✅ *Module Reloaded Successfully*\n\n📦 Module: \`${moduleName}\`\n🔄 Status: Restarted\n⏰ ${new Date().toLocaleTimeString()}`,
                        edit: processingMsg.key
                    });

                } catch (error) {
                    logger.error('Failed to reload module:', error);
                    await context.bot.sendMessage(context.sender, {
                        text: `❌ *Module Reload Failed*\n\n🚫 Error: ${error.message}\n📦 Module: \`${moduleName}\``
                    });
                }
            }
        };

        // List Modules Command
        const listModulesCommand = {
            name: 'modules',
            description: 'List all loaded modules',
            usage: '.modules',
            permissions: 'public',
            execute: async (msg, params, context) => {
                const systemModules = [];
                const customModules = [];
                
                for (const [name, moduleInfo] of this.modules) {
                    if (moduleInfo.isSystem) {
                        systemModules.push(name);
                    } else {
                        customModules.push(name);
                    }
                }

                let moduleText = `🔧 *Loaded Modules*\n\n`;
                moduleText += `📊 **System Modules (${systemModules.length}):**\n`;
                if (systemModules.length > 0) {
                    moduleText += `• ${systemModules.join('\n• ')}\n\n`;
                } else {
                    moduleText += `• None loaded\n\n`;
                }
                
                moduleText += `🎨 **Custom Modules (${customModules.length}):**\n`;
                if (customModules.length > 0) {
                    moduleText += `• ${customModules.join('\n• ')}\n\n`;
                } else {
                    moduleText += `• None loaded\n\n`;
                }
                
                moduleText += `📈 **Total:** ${this.modules.size} modules active`;

                await context.bot.sendMessage(context.sender, { text: moduleText });
            }
        };

        // Register module management commands
        this.bot.messageHandler.registerCommandHandler('lm', loadModuleCommand);
        this.bot.messageHandler.registerCommandHandler('ulm', unloadModuleCommand);
        this.bot.messageHandler.registerCommandHandler('rlm', reloadModuleCommand);
        this.bot.messageHandler.registerCommandHandler('modules', listModulesCommand);
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

        this.systemModulesCount = 0;
        this.customModulesCount = 0;

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

        // Load help system after all modules
        this.setupHelpSystem();

        logger.info(`✅ Loaded ${this.systemModulesCount} System Modules.`);
        logger.info(`✅ Loaded ${this.customModulesCount} Custom Modules.`);
        logger.info(`✅ Total Modules Loaded: ${this.systemModulesCount + this.customModulesCount}`);
    }

    setupHelpSystem() {
        const helpCommand = {
            name: 'help',
            description: 'Show all available modules and commands or detailed help for a specific module',
            usage: '.help [module_name]',
            permissions: 'public',
            execute: async (msg, params, context) => {
                if (params.length > 0) {
                    // Show detailed help for a specific module
                    const moduleName = params[0].toLowerCase();
                    const moduleInfo = this.getModule(moduleName);

                    if (!moduleInfo) {
                        await context.bot.sendMessage(context.sender, {
                            text: `❌ Module \`${moduleName}\` not found.\n\nUse \`.help\` to see all available modules.`
                        });
                        return;
                    }

                    const metadata = moduleInfo.metadata || {};
                    const commands = Array.isArray(moduleInfo.commands) ? moduleInfo.commands : [];
                    let helpText = `📦 *Module: ${moduleName}*\n\n`;
                    helpText += `📝 *Description*: ${metadata.description || 'No description available'}\n`;
                    helpText += `🆚 *Version*: ${metadata.version || 'Unknown'}\n`;
                    helpText += `👤 *Author*: ${metadata.author || 'Unknown'}\n`;
                    helpText += `📂 *Category*: ${metadata.category || 'Uncategorized'}\n`;
                    helpText += `📁 *Type*: ${this.modules.get(moduleName)?.isSystem ? 'System' : 'Custom'}\n\n`;

                    if (commands.length > 0) {
                        helpText += `📋 *Commands* (${commands.length}):\n`;
                        for (const cmd of commands) {
                            helpText += `  • \`${cmd.name}\` - ${cmd.description}\n`;
                            helpText += `    Usage: \`${cmd.usage}\`\n`;
                            helpText += `    Permissions: ${cmd.permissions || 'public'}\n`;
                        }
                    } else {
                        helpText += `📋 *Commands*: None\n`;
                    }

                    await context.bot.sendMessage(context.sender, { text: helpText });
                    return;
                }

                // Show all modules and their commands
                let helpText = `🤖 *${config.get('bot.name')} Help Menu*\n\n`;
                helpText += `🎯 *Prefix*: \`${config.get('bot.prefix')}\`\n`;
                helpText += `📊 *Total Modules*: ${this.modules.size}\n`;
                helpText += `📋 *Total Commands*: ${this.bot.messageHandler.commandHandlers.size}\n\n`;

                const systemModules = [];
                const customModules = [];

                for (const [name, moduleInfo] of this.modules) {
                    if (moduleInfo.isSystem) {
                        systemModules.push({ name, instance: moduleInfo.instance });
                    } else {
                        customModules.push({ name, instance: moduleInfo.instance });
                    }
                }

                // System Modules
                helpText += `📊 *System Modules* (${systemModules.length}):\n`;
                if (systemModules.length > 0) {
                    for (const mod of systemModules) {
                        const commands = Array.isArray(mod.instance.commands) ? mod.instance.commands : [];
                        helpText += `  📦 ${mod.name} (${commands.length} commands)\n`;
                        for (const cmd of commands) {
                            helpText += `    • \`${cmd.name}\` - ${cmd.description} (Usage: \`${cmd.usage}\`)\n`;
                        }
                    }
                } else {
                    helpText += `  • None loaded\n`;
                }
                helpText += `\n`;

                // Custom Modules
                helpText += `🎨 *Custom Modules* (${customModules.length}):\n`;
                if (customModules.length > 0) {
                    for (const mod of customModules) {
                        const commands = Array.isArray(mod.instance.commands) ? mod.instance.commands : [];
                        helpText += `  📦 ${mod.name} (${commands.length} commands)\n`;
                        for (const cmd of commands) {
                            helpText += `    • \`${cmd.name}\` - ${cmd.description} (Usage: \`${cmd.usage}\`)\n`;
                        }
                    }
                } else {
                    helpText += `  • None loaded\n`;
                }

                helpText += `\n💡 *Tip*: Use \`.help <module_name>\` for detailed module info\n`;
                helpText += `🔧 *Module Management*: \`.lm\`, \`.ulm\`, \`.rlm\`, \`.modules\`, \`.moduleinfo\`, \`.allmodules\``;

                await context.bot.sendMessage(context.sender, { text: helpText });
            }
        };

        this.bot.messageHandler.registerCommandHandler('help', helpCommand);
    }

    getCommandModule(commandName) {
        for (const [moduleName, moduleInfo] of this.modules) {
            if (moduleInfo.instance.commands) {
                for (const cmd of moduleInfo.instance.commands) {
                    if (cmd.name === commandName) {
                        return moduleName;
                    }
                }
            }
        }
        return 'Core System';
    }

    async loadModule(filePath, isSystem) {
        const moduleId = path.basename(filePath, '.js');

        try {
            delete require.cache[require.resolve(filePath)];
            const mod = require(filePath);

            const moduleInstance = typeof mod === 'function' && /^\s*class\s/.test(mod.toString()) 
                                   ? new mod(this.bot) 
                                   : mod;

            const actualModuleId = (moduleInstance && moduleInstance.name) ? moduleInstance.name : moduleId;

            // Validate module structure
            if (!moduleInstance.metadata) {
                moduleInstance.metadata = {
                    description: 'No description provided',
                    version: 'Unknown',
                    author: 'Unknown',
                    category: 'Uncategorized',
                    dependencies: []
                };
            }

            if (moduleInstance.init && typeof moduleInstance.init === 'function') {
                await moduleInstance.init();
            }

            if (Array.isArray(moduleInstance.commands)) {
                for (const cmd of moduleInstance.commands) {
                    if (!cmd.name || !cmd.description || !cmd.usage || !cmd.execute) {
                        logger.warn(`⚠️ Invalid command in module ${actualModuleId}: ${JSON.stringify(cmd)}`);
                        continue;
                    }

                    const ui = cmd.ui || {};

                    const wrappedCmd = cmd.autoWrap === false ? cmd : {
                        ...cmd,
                        execute: async (msg, params, context) => {
                            await helpers.smartErrorRespond(context.bot, msg, {
                                processingText: ui.processingText || `⏳ Running *${cmd.name}*...`,
                                errorText: ui.errorText || `❌ *${cmd.name}* failed.`,
                                actionFn: async () => {
                                    return await cmd.execute(msg, params, context);
                                }
                            });
                        }
                    };

                    this.bot.messageHandler.registerCommandHandler(cmd.name, wrappedCmd);
                }
            }
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

        if (moduleInfo.instance.destroy && typeof moduleInfo.instance.destroy === 'function') {
            await moduleInfo.instance.destroy();
        }

        if (Array.isArray(moduleInfo.instance.commands)) {
            for (const cmd of moduleInfo.instance.commands) {
                if (cmd.name) {
                    this.bot.messageHandler.unregisterCommandHandler(cmd.name);
                }
            }
        }
        if (moduleInfo.instance.messageHooks && typeof moduleInfo.instance.messageHooks === 'object') {
            for (const hook of Object.keys(moduleInfo.instance.messageHooks)) {
                this.bot.messageHandler.unregisterMessageHook(hook);
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
        await this.unloadModule(moduleId);
        await this.loadModule(moduleInfo.path, moduleInfo.isSystem);
        logger.info(`✅ Reloaded module: ${moduleId}`);
    }
}

module.exports = ModuleLoader;
