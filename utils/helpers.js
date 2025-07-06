const config = require('../config');

class Helpers {
    static async smartErrorRespond(bot, originalMsg, options = {}) {
        const {
            processingText = '⏳ Processing...',
            errorText = '❌ Something went wrong.',
            actionFn = () => { throw new Error('No action provided'); },
            autoReact = config.get('features.autoReact', true),
            editMessages = config.get('features.messageEdit', true),
            smartProcessing = config.get('features.smartProcessing', false)
        } = options;

        if (!bot?.sock?.sendMessage || !originalMsg?.key?.remoteJid) return;

        const sender = originalMsg.key.remoteJid;
        let processingMsgKey = null;

        try {
            // React with ⏳
            if (autoReact) {
                await bot.sock.sendMessage(sender, {
                    react: { key: originalMsg.key, text: '⏳' }
                });
            }

            // Show "processing..." message
            if (editMessages) {
                const processingMsg = await bot.sendMessage(sender, { text: processingText });
                processingMsgKey = processingMsg.key;
            }

            // Run command
            const result = await actionFn();

            // Wait 1.5s then remove ⏳
            if (autoReact) {
                await Helpers.sleep(1500);
                await bot.sock.sendMessage(sender, {
                    react: { key: originalMsg.key, text: '' }
                });
            }

            // Edit result or send new
            if (processingMsgKey && result && typeof result === 'string') {
                await bot.sock.sendMessage(sender, {
                    text: result,
                    edit: processingMsgKey
                });
            } else if (processingMsgKey && !result) {
                await bot.sock.sendMessage(sender, {
                    text: '✅ Done!',
                    edit: processingMsgKey
                });
            } else if (result && typeof result === 'string') {
                await bot.sendMessage(sender, { text: result });
            }

            return result;

        } catch (error) {
            // Wait 1.5s then replace ⏳ with ❌
            if (autoReact) {
                await Helpers.sleep(1500);
                await bot.sock.sendMessage(sender, {
                    react: { key: originalMsg.key, text: '❌' }
                });
            }

            const finalErrorText = smartProcessing
                ? `${errorText}\n\n🔍 Error: ${error.message}`
                : errorText;

            if (processingMsgKey) {
                await bot.sock.sendMessage(sender, {
                    text: finalErrorText,
                    edit: processingMsgKey
                });
            } else {
                await bot.sendMessage(sender, { text: finalErrorText });
            }

            throw error;
        }
    }

    static async sendCommandResponse(bot, originalMsg, responseText) {
        await this.smartErrorRespond(bot, originalMsg, {
            processingText: '⏳ Checking command...',
            errorText: responseText,
            actionFn: async () => {
                throw new Error(responseText);
            }
        });
    }

    static formatUptime(startTime) {
        if (typeof startTime !== 'number') return '0s';
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        const parts = [];
        if (days) parts.push(`${days}d`);
        if (hours) parts.push(`${hours}h`);
        if (minutes) parts.push(`${minutes}m`);
        if (secs || parts.length === 0) parts.push(`${secs}s`);
        return parts.join(' ');
    }

    static formatFileSize(bytes) {
        if (typeof bytes !== 'number' || bytes <= 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }

    static cleanPhoneNumber(phone) {
        return typeof phone === 'string' ? phone.replace(/[^\d]/g, '') : '';
    }

    static isOwner(participant) {
        const owner = config.get('bot.owner');
        return participant === owner;
    }

    static generateRandomString(length = 8) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    }
}

module.exports = Helpers;
