const logger = require('../utils/logger');

/**
 * Sync-related commands for WhatsApp bot
 */
class SyncCommands {
    constructor() {
        this.name = 'Sync Commands';
        this.version = '1.0.0';
        this.commands = [
            {
                name: 'syncstats',
                description: 'Show message sync statistics',
                execute: this.showSyncStats.bind(this)
            },
            {
                name: 'synctest',
                description: 'Test message sync functionality',
                execute: this.testSync.bind(this)
            },
            {
                name: 'syncreset',
                description: 'Reset sync queue and statistics',
                execute: this.resetSync.bind(this)
            },
            {
                name: 'syncqueue',
                description: 'Show current sync queue status',
                execute: this.showSyncQueue.bind(this)
            },
            {
                name: 'forcesync',
                description: 'Force sync the replied message',
                execute: this.forceSync.bind(this)
            }
        ];
    }

    async showSyncStats(message, args, bot) {
        try {
            const syncDetector = bot.messageHandler.getSyncDetector();
            if (!syncDetector) {
                await bot.sendMessage(message.key.remoteJid, {
                    text: '❌ Sync detector not available'
                });
                return;
            }

            const stats = syncDetector.getSyncStats();
            
            const statsText = `📊 *Message Sync Statistics*\n\n` +
                            `📨 Total Messages: ${stats.totalMessages}\n` +
                            `✅ Processed: ${stats.processedMessages}\n` +
                            `❌ Failed: ${stats.failedMessages}\n` +
                            `📱 Text Messages: ${stats.textMessages}\n` +
                            `🎬 Media Messages: ${stats.mediaMessages}\n` +
                            `📥 Queue Size: ${stats.queueSize}\n` +
                            `📈 Success Rate: ${stats.successRate}\n\n` +
                            `🕐 Last Updated: ${new Date().toLocaleString()}`;

            await bot.sendMessage(message.key.remoteJid, {
                text: statsText
            });

        } catch (error) {
            logger.error('Error showing sync stats:', error);
            await bot.sendMessage(message.key.remoteJid, {
                text: `❌ Error getting sync stats: ${error.message}`
            });
        }
    }

    async testSync(message, args, bot) {
        try {
            const testMessage = {
                key: {
                    id: 'TEST_' + Date.now(),
                    remoteJid: message.key.remoteJid,
                    fromMe: false
                },
                message: {
                    conversation: '🧪 This is a test message for sync functionality'
                },
                messageTimestamp: Math.floor(Date.now() / 1000),
                pushName: 'Sync Test'
            };

            const syncDetector = bot.messageHandler.getSyncDetector();
            if (!syncDetector) {
                await bot.sendMessage(message.key.remoteJid, {
                    text: '❌ Sync detector not available'
                });
                return;
            }

            await bot.sendMessage(message.key.remoteJid, {
                text: '🧪 Testing sync functionality...'
            });

            const result = await syncDetector.detectAndSyncMessage(testMessage, 'test');
            
            const resultText = result 
                ? '✅ Sync test completed successfully!' 
                : '❌ Sync test failed!';
                
            await bot.sendMessage(message.key.remoteJid, {
                text: resultText
            });

        } catch (error) {
            logger.error('Error testing sync:', error);
            await bot.sendMessage(message.key.remoteJid, {
                text: `❌ Sync test error: ${error.message}`
            });
        }
    }

    async resetSync(message, args, bot) {
        try {
            const syncDetector = bot.messageHandler.getSyncDetector();
            if (!syncDetector) {
                await bot.sendMessage(message.key.remoteJid, {
                    text: '❌ Sync detector not available'
                });
                return;
            }

            syncDetector.reset();
            
            await bot.sendMessage(message.key.remoteJid, {
                text: '🔄 Sync queue and statistics have been reset!'
            });

        } catch (error) {
            logger.error('Error resetting sync:', error);
            await bot.sendMessage(message.key.remoteJid, {
                text: `❌ Error resetting sync: ${error.message}`
            });
        }
    }

    async showSyncQueue(message, args, bot) {
        try {
            const syncDetector = bot.messageHandler.getSyncDetector();
            if (!syncDetector) {
                await bot.sendMessage(message.key.remoteJid, {
                    text: '❌ Sync detector not available'
                });
                return;
            }

            const stats = syncDetector.getSyncStats();
            const queueInfo = `📥 *Sync Queue Status*\n\n` +
                             `📊 Messages in Queue: ${stats.queueSize}\n` +
                             `🔄 Processing: ${syncDetector.processingQueue ? 'Yes' : 'No'}\n` +
                             `⏰ Last Check: ${new Date().toLocaleString()}`;

            await bot.sendMessage(message.key.remoteJid, {
                text: queueInfo
            });

        } catch (error) {
            logger.error('Error showing sync queue:', error);
            await bot.sendMessage(message.key.remoteJid, {
                text: `❌ Error getting queue info: ${error.message}`
            });
        }
    }

    async forceSync(message, args, bot) {
        try {
            // Check if this is a reply to another message
            const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMessage) {
                await bot.sendMessage(message.key.remoteJid, {
                    text: '❌ Please reply to a message to force sync it'
                });
                return;
            }

            await bot.sendMessage(message.key.remoteJid, {
                text: '🔄 Force syncing replied message...'
            });

            // Create a mock message object for the quoted message
            const messageToSync = {
                key: {
                    id: 'FORCE_SYNC_' + Date.now(),
                    remoteJid: message.key.remoteJid,
                    fromMe: false
                },
                message: quotedMessage,
                messageTimestamp: Math.floor(Date.now() / 1000),
                pushName: 'Force Sync'
            };

            const result = await bot.messageHandler.forceSyncMessage(messageToSync, 'forceSync');
            
            const resultText = result 
                ? '✅ Message force synced successfully!' 
                : '❌ Force sync failed!';
                
            await bot.sendMessage(message.key.remoteJid, {
                text: resultText
            });

        } catch (error) {
            logger.error('Error force syncing:', error);
            await bot.sendMessage(message.key.remoteJid, {
                text: `❌ Force sync error: ${error.message}`
            });
        }
    }
}

module.exports = SyncCommands;
