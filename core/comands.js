const config = require('../config');
const logger = require('../core/logger');
const { connectDb } = require('../utils/db');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
        this.db = null;
        this.initializeDb();
    }

    async initializeDb() {
        try {
            this.db = await connectDb();
            
            // Create collections if they don't exist
            await this.db.createCollection('bridge_mappings').catch(() => {});
            await this.db.createCollection('user_mappings').catch(() => {});
            await this.db.createCollection('contact_mappings').catch(() => {});
            
            logger.info('📊 Database initialized for Telegram commands');
        } catch (error) {
            logger.error('❌ Failed to initialize database for commands:', error);
        }
    }

    async saveMappings() {
        if (!this.db) return;
        
        try {
            // Save chat mappings
            const chatMappings = Array.from(this.bridge.chatMappings.entries()).map(([jid, topicId]) => ({
                jid,
                topicId,
                updatedAt: new Date()
            }));
            
            if (chatMappings.length > 0) {
                await this.db.collection('bridge_mappings').deleteMany({});
                await this.db.collection('bridge_mappings').insertMany(chatMappings);
            }

            // Save user mappings
            const userMappings = Array.from(this.bridge.userMappings.entries()).map(([participant, data]) => ({
                participant,
                ...data,
                updatedAt: new Date()
            }));
            
            if (userMappings.length > 0) {
                await this.db.collection('user_mappings').deleteMany({});
                await this.db.collection('user_mappings').insertMany(userMappings);
            }

            // Save contact mappings
            const contactMappings = Array.from(this.bridge.contactMappings.entries()).map(([phone, name]) => ({
                phone,
                name,
                updatedAt: new Date()
            }));
            
            if (contactMappings.length > 0) {
                await this.db.collection('contact_mappings').deleteMany({});
                await this.db.collection('contact_mappings').insertMany(contactMappings);
            }

            logger.debug('💾 Bridge mappings saved to database');
        } catch (error) {
            logger.error('❌ Failed to save mappings to database:', error);
        }
    }

    async loadMappings() {
        if (!this.db) return;
        
        try {
            // Load chat mappings
            const chatMappings = await this.db.collection('bridge_mappings').find({}).toArray();
            for (const mapping of chatMappings) {
                this.bridge.chatMappings.set(mapping.jid, mapping.topicId);
            }

            // Load user mappings
            const userMappings = await this.db.collection('user_mappings').find({}).toArray();
            for (const mapping of userMappings) {
                const { participant, ...data } = mapping;
                delete data._id;
                delete data.updatedAt;
                this.bridge.userMappings.set(participant, data);
            }

            // Load contact mappings
            const contactMappings = await this.db.collection('contact_mappings').find({}).toArray();
            for (const mapping of contactMappings) {
                this.bridge.contactMappings.set(mapping.phone, mapping.name);
            }

            logger.info(`📊 Loaded mappings from database: ${chatMappings.length} chats, ${userMappings.length} users, ${contactMappings.length} contacts`);
        } catch (error) {
            logger.error('❌ Failed to load mappings from database:', error);
        }
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.split(' ');
        
        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;
                    
                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;
                    
                case '/restart':
                    await this.handleRestart(msg.chat.id);
                    break;
                    
                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;
                    
                case '/contacts':
                    await this.handleContacts(msg.chat.id);
                    break;
                    
                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;

                case '/bridge':
                    await this.handleBridge(msg.chat.id, args);
                    break;

                case '/db':
                    await this.handleDatabase(msg.chat.id, args);
                    break;
                    
                default:
                    await this.handleHelp(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(msg.chat.id, 
                `❌ Error executing command: ${error.message}`);
        }
    }

    async handleStart(chatId) {
        const welcomeText = `🤖 *WhatsApp-Telegram Bridge Bot*\n\n` +
                           `✅ Bridge Status: ${this.bridge.whatsappBot.sock ? 'Connected' : 'Disconnected'}\n` +
                           `📱 WhatsApp: ${this.bridge.whatsappBot.sock?.user?.name || 'Not connected'}\n` +
                           `🔗 Contacts: ${this.bridge.contactMappings.size} synced\n` +
                           `💾 Database: ${this.db ? 'Connected' : 'Disconnected'}\n\n` +
                           `*Available Commands:*\n` +
                           `/status - Check bridge status\n` +
                           `/restart - Restart bridge\n` +
                           `/send <number> <message> - Send message\n` +
                           `/contacts - List contacts\n` +
                           `/sync - Sync contacts\n` +
                           `/bridge <start|stop|status> - Control bridge\n` +
                           `/db <save|load|clear> - Database operations`;
        
        await this.bridge.telegramBot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        
        const status = `📊 *Bridge Status*\n\n` +
                      `🔗 WhatsApp: ${this.bridge.whatsappBot.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
                      `📱 User: ${this.bridge.whatsappBot.sock?.user?.name || 'N/A'}\n` +
                      `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
                      `💬 Active Chats: ${this.bridge.chatMappings.size}\n` +
                      `👥 Users: ${this.bridge.userMappings.size}\n` +
                      `💾 Database: ${this.db ? '✅ Connected' : '❌ Disconnected'}\n` +
                      `🔄 Processing: ${this.bridge.isProcessing ? 'Yes' : 'No'}\n` +
                      `⏰ Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
                      `💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;
        
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleRestart(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Restarting bridge...');
        
        try {
            // Save current mappings before restart
            await this.saveMappings();
            
            // Clear mappings
            this.bridge.chatMappings.clear();
            this.bridge.userMappings.clear();
            
            // Reload from database
            await this.loadMappings();
            
            // Resync contacts
            await this.bridge.syncContacts();
            
            await this.bridge.telegramBot.sendMessage(chatId, '✅ Bridge restarted successfully!');
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Restart failed: ${error.message}`);
        }
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                '❌ Usage: /send <number> <message>\n\nExample: /send 1234567890 Hello there!');
            return;
        }
        
        const number = args[0];
        const message = args.slice(1).join(' ');
        
        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            
            if (result?.key?.id) {
                await this.bridge.telegramBot.sendMessage(chatId, `✅ Message sent to ${number}`);
            } else {
                await this.bridge.telegramBot.sendMessage(chatId, `⚠️ Message may not have been delivered to ${number}`);
            }
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to send message: ${error.message}`);
        }
    }

    async handleContacts(chatId) {
        if (this.bridge.contactMappings.size === 0) {
            await this.bridge.telegramBot.sendMessage(chatId, '📞 No contacts found. Use /sync to sync contacts.');
            return;
        }
        
        let contactsList = '📞 *Contacts List:*\n\n';
        let count = 0;
        
        for (const [phone, name] of this.bridge.contactMappings.entries()) {
            contactsList += `${name} - +${phone}\n`;
            count++;
            
            if (count >= 50) { // Limit to prevent message too long
                contactsList += '\n... and more';
                break;
            }
        }
        
        contactsList += `\n📊 Total: ${this.bridge.contactMappings.size} contacts`;
        
        await this.bridge.telegramBot.sendMessage(chatId, contactsList, { parse_mode: 'Markdown' });
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...');
        
        try {
            await this.bridge.syncContacts();
            await this.saveMappings(); // Save after sync
            await this.bridge.telegramBot.sendMessage(chatId, 
                `✅ Contacts synced successfully!\n📞 Total: ${this.bridge.contactMappings.size} contacts`);
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Sync failed: ${error.message}`);
        }
    }

    async handleBridge(chatId, args) {
        if (args.length === 0) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                '❓ Usage: /bridge <action>\n\nActions:\n• start - Start bridge\n• stop - Stop bridge\n• status - Show bridge status');
            return;
        }

        const action = args[0].toLowerCase();
        
        switch (action) {
            case 'start':
                try {
                    if (this.bridge.telegramBot) {
                        await this.bridge.telegramBot.sendMessage(chatId, '⚠️ Bridge is already running');
                        return;
                    }
                    
                    await this.bridge.initialize();
                    await this.loadMappings(); // Load mappings after start
                    await this.bridge.telegramBot.sendMessage(chatId, '✅ Bridge started successfully');
                } catch (error) {
                    await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to start bridge: ${error.message}`);
                }
                break;
                
            case 'stop':
                try {
                    await this.saveMappings(); // Save before stop
                    await this.bridge.shutdown();
                    // Note: Can't send message after shutdown as bot is stopped
                } catch (error) {
                    logger.error('Failed to stop bridge:', error);
                }
                break;
                
            case 'status':
                await this.handleStatus(chatId);
                break;
                
            default:
                await this.bridge.telegramBot.sendMessage(chatId, 
                    `❌ Unknown action: ${action}\nUse: start, stop, or status`);
        }
    }

    async handleDatabase(chatId, args) {
        if (!this.db) {
            await this.bridge.telegramBot.sendMessage(chatId, '❌ Database not connected');
            return;
        }

        if (args.length === 0) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                '❓ Usage: /db <action>\n\nActions:\n• save -
