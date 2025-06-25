const config = require('../config');

class MenuModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'Menu System';
        this.version = '1.1.0'; // Updated version for dynamic functionality
        this.commands = [
            {
                name: 'menu',
                description: 'Display main menu',
                usage: '.menu',
                category: 'General',
                execute: this.showMenu.bind(this)
            },
            {
                name: 'help',
                description: 'Show help information for commands or modules',
                usage: '.help [command_name]',
                category: 'General',
                execute: this.showHelp.bind(this)
            },
            {
                name: 'status',
                description: 'Show bot status and system information',
                usage: '.status',
                category: 'General',
                execute: this.showStatus.bind(this)
            },
            {
                name: 'modules',
                description: 'List all loaded modules',
                usage: '.modules',
                category: 'General',
                execute: this.showModules.bind(this)
            },
            {
                name: 'settings',
                description: 'View/change bot settings (if settings module is loaded)',
                usage: '.settings [key] [value]',
                category: 'General',
                execute: async (msg, params, context) => {
                    // This is a placeholder. A dedicated 'settings' module would handle this.
                    await context.bot.sendMessage(context.sender, { text: `Command ${config.get('bot.prefix')}settings is not yet implemented or its module is not loaded.` });
                }
            }
        ];
    }

    /**
     * Helper method to retrieve all registered command objects from the MessageHandler.
     * @returns {Array<object>} An array of registered command objects.
     */
    getAllRegisteredCommands() {
        if (this.bot.messageHandler && typeof this.bot.messageHandler.getRegisteredCommands === 'function') {
            return Array.from(this.bot.messageHandler.getRegisteredCommands().values());
        }
        return [];
    }

    /**
     * Displays the main menu of commands, categorized dynamically.
     * @param {object} msg - The original WhatsApp message object.
     * @param {string[]} params - Command parameters (unused for .menu).
     * @param {object} context - Context object containing bot, sender, participant, isGroup.
     */
    async showMenu(msg, params, context) {
        const prefix = config.get('bot.prefix');
        const botName = config.get('bot.name');
        const version = config.get('bot.version');

        let menuText = `*🌌 ${botName.toUpperCase()} v${version} - COMMAND GALAXY 🌌*\n` +
                        `_Advanced Modular WhatsApp Bot_\n` +
                        `_Created by ${config.get('bot.company')}_\n\n`;

        const registeredCommands = this.getAllRegisteredCommands();
        const categorizedCommands = {};

        // Organize commands by category
        registeredCommands.forEach(cmd => {
            // Only include commands that have an 'execute' function
            if (typeof cmd.execute === 'function') {
                const category = cmd.category || 'Uncategorized'; // Default category if not specified
                if (!categorizedCommands[category]) {
                    categorizedCommands[category] = [];
                }
                categorizedCommands[category].push(cmd);
            }
        });

        // Define a desired order for categories to maintain consistent menu appearance
        const categoryOrder = [
            'General', 'Fun & Games', 'Utilities', 'Group Admin', 'Downloads', 'Media', 'AI', 'Owner', 'Uncategorized'
        ];

        // Append commands by category
        categoryOrder.forEach(category => {
            if (categorizedCommands[category] && categorizedCommands[category].length > 0) {
                // Determine icon based on category for visual appeal
                let icon = '✨'; // Default icon
                switch(category) {
                    case 'General': icon = '⚙️'; break;
                    case 'Fun & Games': icon = '🎲'; break;
                    case 'Utilities': icon = '🛠️'; break;
                    case 'Group Admin': icon = '👥'; break;
                    case 'Downloads': icon = '📥'; break;
                    case 'Media': icon = '🖼️'; break;
                    case 'AI': icon = '🧠'; break;
                    case 'Owner': icon = '👑'; break;
                    default: icon = '📄'; // For uncategorized or new categories
                }
                menuText += `*${icon} ${category.toUpperCase()}*\n`;
                // Sort commands alphabetically within each category for consistent display
                categorizedCommands[category].sort((a, b) => a.name.localeCompare(b.name)).forEach(cmd => {
                    menuText += `  ${icon} *${prefix}${cmd.name}* - ${cmd.description}\n`;
                });
                menuText += `\n`;
            }
        });

        // Add the fixed sections that don't come from command modules (e.g., bot status, bridge info)
        menuText += `*🤖 TELEGRAM BRIDGE*\n` +
                    `${config.get('telegram.enabled') ? '✅ Active' : '❌ Inactive'}\n` +
                    `${config.get('telegram.enabled') ? `🔗 Connected to Telegram group` : `Use *${prefix}telegram setup* to configure`}\n\n` +
                    `*⚙️ CURRENT STATUS*\n` +
                    `• Mode: ${config.get('features.mode').toUpperCase()}\n` +
                    `• Auto View: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n` +
                    `• Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n` +
                    `• Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n\n` +
                    `_Type *${prefix}help <command>* for detailed help!_`;

        await context.bot.sendMessage(context.sender, { text: menuText });
    }

    /**
     * Displays help information for a specific command or general help.
     * It now tries to get help text directly from the module if available.
     * @param {object} msg - The original WhatsApp message object.
     * @param {string[]} params - Array of parameters (e.g., ['weather']).
     * @param {object} context - Context object containing bot, sender, participant, isGroup.
     */
    async showHelp(msg, params, context) {
        const prefix = config.get('bot.prefix');
        const allCommands = this.getAllRegisteredCommands();
        // Create a map for quick lookup of command objects by name
        const commandMap = new Map(allCommands.map(cmd => [cmd.name.toLowerCase(), cmd]));
        // Also create a map to quickly get the module instance by command name
        // This requires iterating through loadedModules to find which module owns which command
        const moduleMapByCommand = new Map();
        Array.from(context.bot.loadedModules.values()).forEach(moduleInfo => {
            if (moduleInfo.instance.commands) {
                moduleInfo.instance.commands.forEach(cmd => {
                    moduleMapByCommand.set(cmd.name.toLowerCase(), moduleInfo.instance);
                });
            }
        });


        if (params.length === 0) {
            // General help message if no command is specified
            const helpText = `*🆘 HELP SYSTEM*\n\n` +
                             `*Usage:* ${prefix}help <command_name>\n` +
                             `*Example:* ${prefix}help weather\n\n` +
                             `*Need more help?*\n` +
                             `• Check our documentation\n` +
                             `• Join our support group\n` +
                             `• Report issues on GitHub\n\n` +
                             `_Type *${prefix}menu* to see all available commands._`;
            
            await context.bot.sendMessage(context.sender, { text: helpText });
        } else {
            const commandName = params[0].toLowerCase();
            const command = commandMap.get(commandName);
            
            if (command) {
                // Check if the module owning this command has a getHelpText method
                const moduleInstance = moduleMapByCommand.get(commandName);
                if (moduleInstance && typeof moduleInstance.getHelpText === 'function') {
                    // If it does, use the module's specific help text
                    const moduleHelpText = await moduleInstance.getHelpText(prefix);
                    await context.bot.sendMessage(context.sender, { text: moduleHelpText });
                } else {
                    // Fallback to generic command help if module-specific help isn't available
                    const helpText = `*📖 HELP: ${command.name.toUpperCase()}*\n\n` +
                                     `*Description:* ${command.description}\n` +
                                     `*Usage:* ${command.usage}\n` +
                                     `${command.category ? `*Category:* ${command.category}\n` : ''}\n\n` +
                                     `_For more commands, type ${prefix}menu_`;
                    
                    await context.bot.sendMessage(context.sender, { text: helpText });
                }
            } else {
                // Command not found
                await context.bot.sendMessage(context.sender, {
                    text: `❌ Command *${prefix}${commandName}* not found. Type *${prefix}menu* for available commands.`
                });
            }
        }
    }

    /**
     * Displays the bot's current status and system information.
     * @param {object} msg - The original WhatsApp message object.
     * @param {string[]} params - Command parameters (unused for .status).
     * @param {object} context - Context object containing bot, sender, participant, isGroup.
     */
    async showStatus(msg, params, context) {
        const uptime = process.uptime(); // Node.js process uptime in seconds
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        
        const statusText = `*🤖 BOT STATUS*\n\n` +
                            `📊 *System Info:*\n` +
                            `• Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
                            `• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n` +
                            `• Node.js: ${process.version}\n\n` +
                            `⚙️ *Features:*\n` +
                            `• Mode: ${config.get('features.mode').toUpperCase()}\n` +
                            `• Auto View: ${config.get('features.autoViewStatus') ? '✅' : '❌'}\n` +
                            `• Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                            `• Rate Limiting: ${config.get('features.rateLimiting') ? '✅' : '❌'}\n\n` +
                            `📦 *Modules:* ${context.bot.loadedModules.size} loaded`; // Access loadedModules from bot instance

        await context.bot.sendMessage(context.sender, { text: statusText });
    }

    /**
     * Displays a list of all currently loaded modules.
     * @param {object} msg - The original WhatsApp message object.
     * @param {string[]} params - Command parameters (unused for .modules).
     * @param {object} context - Context object containing bot, sender, participant, isGroup.
     */
    async showModules(msg, params, context) {
        // Retrieve loaded modules information from the bot's moduleLoader instance
        const modules = context.bot.moduleLoader.getLoadedModules(); 
        
        let moduleText = `*📦 LOADED MODULES*\n\n`;
        
        if (modules.length === 0) {
            moduleText += `❌ No modules loaded.`;
        } else {
            // Iterate through the array of module info objects
            modules.forEach(info => { 
                moduleText += `🔧 *${info.name}* v${info.version}\n`;
                moduleText += `    ID: ${info.id}\n`;
                moduleText += `    Type: ${info.type}\n`; // Display module type (core/custom)
                moduleText += `    Loaded: ${info.loaded.toLocaleString()}\n\n`;
            });
        }

        await context.bot.sendMessage(context.sender, { text: moduleText });
    }
}

module.exports = MenuModule;
