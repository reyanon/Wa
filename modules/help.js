// modules/help.js
const { registerHelp, getHelp, getModuleHelp, getCommandHelp } = require('../utils/help');
const config = require('../config');

const prefix = config.get('bot.prefix');

module.exports = {
    name: 'help',
    version: '1.0.0',
    commands: [
        {
            name: 'help',
            pattern: new RegExp(`^\${prefix}help(?:\s+(\w+))?$`, 'i'),
            handler: async ({ message, match, bot }) => {
                const arg = match[1];

                if (!arg) {
                    const helpData = getHelp();
                    const helpText = Object.keys(helpData)
                        .map(mod => `• ${mod}: ${Object.keys(helpData[mod]).join(', ')}`)
                        .join('\n');

                    return await bot.sendMessage(message.key.remoteJid, {
                        text: `📚 *Help Menu*\n\n${helpText}`
                    });
                }

                const moduleHelp = getModuleHelp(arg);
                if (moduleHelp) {
                    const helpLines = Object.entries(moduleHelp).map(
                        ([cmd, desc]) => `• \`${prefix}${cmd}\` — ${desc}`
                    );
                    return await bot.sendMessage(message.key.remoteJid, {
                        text: `📖 *${arg} Module Help*\n\n${helpLines.join('\n')}`
                    });
                }

                const cmdHelp = getCommandHelp(arg);
                if (cmdHelp) {
                    return await bot.sendMessage(message.key.remoteJid, {
                        text: `🔍 *Command Help*\nModule: ${cmdHelp.module}\nCommand: \`${prefix}${cmdHelp.command}\`\nDescription: ${cmdHelp.desc}`
                    });
                }

                return await bot.sendMessage(message.key.remoteJid, {
                    text: `❌ No help found for \`${arg}\``
                });
            }
        }
    ]
};

registerHelp("help", {
    "help [module/command]": "Show help menu or details for a specific module or command"
});
