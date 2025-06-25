const { AdvancedWhatsAppBot } = require('/core/bot');
const logger = require('core/logger');

async function main() {
    try {
        logger.info('🚀 Starting Advanced WhatsApp Bot...');
        
        const bot = new AdvancedWhatsAppBot();
        await bot.initialize();
        
        // Graceful shutdown handlers
        process.on('SIGINT', async () => {
            logger.info('🛑 Received SIGINT, shutting down gracefully...');
            await bot.shutdown();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('🛑 Received SIGTERM, shutting down gracefully...');
            await bot.shutdown();
            process.exit(0);
        });

        process.on('uncaughtException', (error) => {
            logger.error('💥 Uncaught Exception:', error);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
            process.exit(1);
        });

    } catch (error) {
        logger.error('💥 Failed to start bot:', error);
        process.exit(1);
    }
}

main();
