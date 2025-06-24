const config = require('../config');

class MenuModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'Menu System';
        this.version = '1.0.0';
        this.commands = [
            {
                name: 'menu',
                description: 'Display main menu',
                usage: '.menu',
                execute: this.showMenu.bind(this)
            },
            {
                name: 'help',
                description: 'Show help information',
                usage: '.help [command]',
                execute: this.showHelp.bind(this)
            },
            {
                name: 'status',
                description: 'Show bot status',
                usage: '.status',
                execute: this.showStatus.bind(this)
            },
            {
                name: 'modules',
                description: 'List loaded modules',
                usage: '.modules',
                execute: this.showModules.bind(this)
            }
        ];
    }

    async showMenu(msg, params, context) {
        const prefix = config.get('bot.prefix');
        const botName = config.get('bot.name');
        const version = config.get('bot.version');
        
        const menuText = `*🌌 ${botName.toUpperCase()} v${version} - COMMAND GALAXY 🌌*\n` +
                        `_Advanced Modular WhatsApp Bot_\n` +
                        `_Created by ${config.get('bot.company')}_\n\n` +
                        `*🎨 GENERAL COMMANDS*\n` +
                        `✨ *${prefix}menu* - Show this menu\n` +
                        `✨ *${prefix}help* - Get help\n` +
                        `✨ *${prefix}status* - Bot status\n` +
                        `✨ *${prefix}modules* - List loaded modules\n` +
                        `✨ *${prefix}settings* - View/change settings\n\n` +
                        `*🌟 FUN & GAMES*\n` +
                        `🎲 *${prefix}quote* - Random quote\n` +
                        `🎲 *${prefix}joke* - Random joke\n` +
                        `🎲 *${prefix}meme* - Random meme\n` +
                        `🎲 *${prefix}trivia* - Trivia question\n` +
                        `🎲 *${prefix}rps* <choice> - Rock Paper Scissors\n` +
                        `🎲 *${prefix}dice* - Roll dice\n` +
                        `🎲 *${prefix}coin* - Flip coin\n\n` +
                        `*🛠️ UTILITIES*\n` +
                        `🔧 *${prefix}weather* <city> - Weather info\n` +
                        `🔧 *${prefix}translate* <text> to <lang> - Translate\n` +
                        `🔧 *${prefix}qr* <text> - Generate QR code\n` +
                        `🔧 *${prefix}reminder* <msg> in <minutes> - Set reminder\n\n` +
                        `*👥 GROUP ADMIN*\n` +
                        `🤝 *${prefix}kick* @user - Remove user\n` +
                        `🤝 *${prefix}promote* @user - Make admin\n` +
                        `🤝 *${prefix}demote* @user - Remove admin\n` +
                        `🤝 *${prefix}tagall* - Tag everyone\n\n` +
                        `*📥 DOWNLOADS*\n` +
                        `⬇️ *${prefix}ytmp3* <url> - YouTube to MP3\n` +
                        `⬇️ *${prefix}ytmp4* <url> - YouTube to MP4\n` +
                        `⬇️ *${prefix}igdl* <url> - Instagram download\n` +
                        `⬇️ *${prefix}tiktok* <url> - TikTok download\n\n` +
                        `*🤖 TELEGRAM BRIDGE*\n` +
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
        
        if (params.length === 0) {
            const helpText = `*🆘 HELP SYSTEM*\n\n` +
                           `*Usage:* ${prefix}help <command>\n` +
                           `*Example:* ${prefix}help weather\n\n` +
                           `*Available Commands:*\n` +
                           `Type *${prefix}menu* to see all commands\n\n` +
                           `*Need more help?*\n` +
                           `• Check our documentation\n` +
                           `• Join our support group\n` +
                           `• Report issues on GitHub`;
            
            await context.bot.sendMessage(context.sender, { text: helpText });
        } else {
            // Show help for specific command
            const command = params[0].toLowerCase();
            const helpText = `*📖 HELP: ${command.toUpperCase()}*\n\n` +
                           `Command information will be displayed here based on the specific command requested.`;
            
            await context.bot.sendMessage(context.sender, { text: helpText });
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
        const modules = Array.from(context.bot.loadedModules.entries());
        
        let moduleText = `*📦 LOADED MODULES*\n\n`;
        
        modules.forEach(([id, info]) => {
            moduleText += `🔧 *${info.instance.name}* v${info.instance.version}\n`;
            moduleText += `   ID: ${id}\n`;
            moduleText += `   Loaded: ${info.loaded.toLocaleString()}\n\n`;
        });

        if (modules.length === 0) {
            moduleText += `❌ No modules loaded`;
        }

        await context.bot.sendMessage(context.sender, { text: moduleText });
    }
}

module.exports = MenuModule;