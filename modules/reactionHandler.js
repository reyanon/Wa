// reactionHandler.js
module.exports = {
    async confirmSuccessReaction(bot, chatId, messageId) {
        try {
            await bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👍' }]);
        } catch (error) {
            console.debug('✅ Reaction failed silently:', error.message);
        }
    },

    async confirmFailureReaction(bot, chatId, messageId) {
        try {
            await bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '❌' }]);
        } catch (error) {
            console.debug('❌ Reaction failed silently:', error.message);
        }
    },

    async confirmStatusReplyReaction(bot, chatId, messageId) {
        try {
            await bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '✅' }]);
        } catch (error) {
            console.debug('⚠️ Status reaction failed silently:', error.message);
        }
    }
};
