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
                category: 'General', // Added category
                execute: this.showMenu.bind(this)
            },
            {
                name: 'help',
                description: 'Show help information',
                usage: '.help [command]',
                category: 'General',
                execute: this.showHelp.bind(this)
            },
            {
                name: 'status',
                description: 'Show bot status',
                usage: '.status',
                category: 'General',
                execute: this.showStatus.bind(this)
            },
            {
                name: 'modules',
                description: 'List loaded modules',
                usage: '.modules',
                category: 'General',
                execute: this.showModules.bind(this)
            },
            // Add a placeholder for settings command if it exists in another module
            {
                name: 'settings',
                description: 'View/change bot settings',
                usage: '.settings [key] [value]',
                category: 'General',
                // This command's execute function would be in a separate settings module
                // For now, it will just show generic help if .settings module is not loaded
                execute: async (msg, params, context) => {
                    await context.bot.sendMessage(context.sender, { text: `Command ${config.get('bot.prefix')}settings is not implemented or its module is not loaded.` });
                }
            }
        ];
    }

    // Helper to get all registered commands from MessageHandler
    getAllRegisteredCommands() {
        // Ensure MessageHandler is available and has the method
        if (this.bot.messageHandler && typeof this.bot.messageHandler.getRegisteredCommands === 'function') {
            // Convert Map to an array of command objects
            return Array.from(this.bot.messageHandler.getRegisteredCommands().values());
        }
        return [];
    }

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
            const category = cmd.category || 'Uncategorized'; // Default category if not specified
            if (!categorizedCommands[category]) {
                categorizedCommands[category] = [];
            }
            categorizedCommands[category].push(cmd);
        });

        // Define a desired order for categories
        const categoryOrder = [
            'General', 'Fun & Games', 'Utilities', 'Group Admin', 'Downloads', 'Media', 'AI', 'Owner', 'Uncategorized'
        ];

        // Append commands by category
        categoryOrder.forEach(category => {
            if (categorizedCommands[category] && categorizedCommands[category].length > 0) {
                // Determine icon based on category (you can expand this)
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
                }
                menuText += `*${icon} ${category.toUpperCase()}*\n`;
                // Sort commands alphabetically within each category for consistent display
                categorizedCommands[category].sort((a, b) => a.name.localeCompare(b.name)).forEach(cmd => {
                    menuText += `  ${icon} *${prefix}${cmd.name}* - ${cmd.description}\n`;
                });
                menuText += `\n`;
            }
        });

        // Add the fixed sections that don't come from command modules
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

    async showHelp(msg, params, context) {
        const prefix = config.get('bot.prefix');
        const allCommands = this.getAllRegisteredCommands();
        const commandMap = new Map(allCommands.map(cmd => [cmd.name.toLowerCase(), cmd]));

        if (params.length === 0) {
            const helpText = `*🆘 HELP SYSTEM*\n\n` +
                             `*Usage:* ${prefix}help <command>\n` +
                             `*Example:* ${prefix}help weather\n\n` +
                             `*Available Commands:*\n` +
                             `_Use ${prefix}menu to see the full list with descriptions._\n` +
                             `_Currently registered:_ ${allCommands.map(c => `${prefix}${c.name}`).join(', ')}\n\n` +
                             `*Need more help?*\n` +
                             `• Check our documentation\n` +
                             `• Join our support group\n` +
                             `• Report issues on GitHub`;
            
            await context.bot.sendMessage(context.sender, { text: helpText });
        } else {
            const commandName = params[0].toLowerCase();
            const command = commandMap.get(commandName);
            
            if (command) {
                const helpText = `*📖 HELP: ${command.name.toUpperCase()}*\n\n` +
                                 `*Description:* ${command.description}\n` +
                                 `*Usage:* ${command.usage}\n` +
                                 `${command.category ? `*Category:* ${command.category}\n` : ''}\n` +
                                 `_For more commands, type ${prefix}menu_`;
                
                await context.bot.sendMessage(context.sender, { text: helpText });
            } else {
                await context.bot.sendMessage(context.sender, { text: `❌ Command *${prefix}${commandName}* not found. Type *${prefix}menu* for available commands.` });
            }
        }
    }

    async showStatus(msg, params, context) {
        const uptime = process.uptime();
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
                            `📦 *Modules:* ${context.bot.loadedModules.size} loaded`;

        await context.bot.sendMessage(context.sender, { text: statusText });
    }

    async showModules(msg, params, context) {
        const modules = context.bot.moduleLoader.getLoadedModules(); // Get loaded modules from moduleLoader
        
        let moduleText = `*📦 LOADED MODULES*\n\n`;
        
        if (modules.length === 0) {
            moduleText += `❌ No modules loaded`;
        } else {
            modules.forEach(info => { // Iterate through the array returned by getLoadedModules()
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
