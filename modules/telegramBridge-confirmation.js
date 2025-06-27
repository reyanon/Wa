// telegramBridge-confirmation.js
module.exports = {
    async confirmTelegramDelivery(bot, chatId, messageId) {
        try {
            await bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👍' }]);
        } catch (error) {
            console.debug('✅ Telegram delivery reaction failed silently:', error.message);
        }
    },

    async confirmTelegramFailure(bot, chatId, messageId) {
        try {
            await bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '❌' }]);
        } catch (error) {
            console.debug('❌ Telegram failure reaction failed silently:', error.message);
        }
    },

    async confirmStatusReply(bot, chatId, messageId) {
        try {
            await bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '✅' }]);
        } catch (error) {
            console.debug('⚠️ Telegram status reply reaction failed silently:', error.message);
        }
    }
};
