const logger = require('../../core/logger');

class ContactManager {
    constructor(telegramBridge) {
        this.bridge = telegramBridge;
        this.syncInProgress = false;
    }

    async initialize() {
        logger.info('👥 Contact Manager initialized');
    }

    async syncAllContacts() {
        if (this.syncInProgress) {
            logger.warn('⚠️ Contact sync already in progress');
            return;
        }

        this.syncInProgress = true;
        
        try {
            logger.info('🔄 Starting contact sync...');
            
            const whatsappBot = this.bridge.getWhatsAppBot();
            if (!whatsappBot || !whatsappBot.sock) {
                throw new Error('WhatsApp bot not available');
            }

            // Get all chats from WhatsApp
            const chats = await whatsappBot.sock.getChats();
            let syncedCount = 0;

            for (const chat of chats) {
                try {
                    await this.syncSingleContact(chat);
                    syncedCount++;
                    
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    logger.error(`Failed to sync contact ${chat.id}:`, error);
                }
            }

            logger.info(`✅ Contact sync completed: ${syncedCount} contacts`);
            
            // Notify Telegram
            await this.bridge.logToTelegram('📥 Contact Sync Completed', 
                `Successfully synced ${syncedCount} contacts from WhatsApp.`);
                
        } catch (error) {
            logger.error('❌ Contact sync failed:', error);
            await this.bridge.logToTelegram('❌ Contact Sync Failed', 
                `Error: ${error.message}`);
        } finally {
            this.syncInProgress = false;
        }
    }

    async syncSingleContact(chat) {
        const whatsappBot = this.bridge.getWhatsAppBot();
        const database = this.bridge.getDatabase();
        
        const isGroup = chat.id.endsWith('@g.us');
        let contactData = {
            jid: chat.id,
            phone: isGroup ? '' : chat.id.split('@')[0],
            name: chat.name || '',
            pushName: chat.pushName || '',
            isGroup: isGroup,
            groupName: isGroup ? (chat.subject || chat.name || '') : '',
            profilePicture: '',
            lastActive: new Date()
        };

        // Get profile picture
        try {
            const ppUrl = await whatsappBot.sock.profilePictureUrl(chat.id, 'image');
            if (ppUrl) {
                contactData.profilePicture = ppUrl;
            }
        } catch (error) {
            // Profile picture not available
        }

        // Get group metadata if it's a group
        if (isGroup) {
            try {
                const groupMeta = await whatsappBot.sock.groupMetadata(chat.id);
                contactData.groupName = groupMeta.subject;
                contactData.name = groupMeta.subject;
            } catch (error) {
                logger.debug(`Could not get group metadata for ${chat.id}`);
            }
        }

        // Save to database
        await database.saveContact(contactData);
        
        // Update existing topic name if changed
        const chatMapping = await database.getChatMapping(chat.id);
        if (chatMapping && chatMapping.topicName !== contactData.name) {
            await this.updateTopicName(chatMapping.telegramTopicId, contactData.name);
            await database.updateTopicName(chat.id, contactData.name);
        }

        return contactData;
    }

    async syncProfilePictures() {
        try {
            logger.info('🖼️ Starting profile picture sync...');
            
            const database = this.bridge.getDatabase();
            const contacts = await database.getAllContacts();
            const whatsappBot = this.bridge.getWhatsAppBot();
            
            let updatedCount = 0;

            for (const contact of contacts) {
                try {
                    const oldPicture = contact.profilePicture;
                    const newPicture = await whatsappBot.sock.profilePictureUrl(contact.jid, 'image');
                    
                    if (newPicture && newPicture !== oldPicture) {
                        await database.updateContactProfilePicture(contact.jid, newPicture);
                        
                        // Send updated picture to Telegram if there's an active chat
                        const chatMapping = await database.getChatMapping(contact.jid);
                        if (chatMapping) {
                            await this.sendProfilePictureUpdate(chatMapping.telegramTopicId, contact, newPicture);
                        }
                        
                        updatedCount++;
                    }
                    
                    // Small delay
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    logger.debug(`Could not sync picture for ${contact.jid}:`, error);
                }
            }

            logger.info(`✅ Profile picture sync completed: ${updatedCount} updates`);
            
        } catch (error) {
            logger.error('❌ Profile picture sync failed:', error);
        }
    }

    async sendProfilePictureUpdate(topicId, contact, newPictureUrl) {
        try {
            const telegramBot = this.bridge.getTelegramBot();
            const targetChatId = this.bridge.getTargetChatId();
            
            if (!telegramBot || !targetChatId) return;

            const updateMsg = `🖼️ *Profile Picture Updated*\n\n` +
                            `👤 Contact: ${contact.name || contact.phone}\n` +
                            `📱 Phone: ${contact.phone}\n` +
                            `⏰ Updated: ${new Date().toLocaleString()}`;

            // Send the new profile picture
            await telegramBot.sendPhoto(targetChatId, newPictureUrl, {
                caption: updateMsg,
                parse_mode: 'Markdown',
                message_thread_id: topicId
            });

        } catch (error) {
            logger.error('Failed to send profile picture update:', error);
        }
    }

    async updateTopicName(topicId, newName) {
        try {
            const telegramBot = this.bridge.getTelegramBot();
            const targetChatId = this.bridge.getTargetChatId();
            
            if (!telegramBot || !targetChatId) return;

            await telegramBot.editForumTopic(targetChatId, topicId, {
                name: newName
            });

            logger.info(`✅ Updated topic name to: ${newName}`);
            
        } catch (error) {
            logger.error('Failed to update topic name:', error);
        }
    }

    async getContactInfo(jid) {
        try {
            const database = this.bridge.getDatabase();
            const contact = await database.getContact(jid);
            
            if (contact) {
                return contact;
            }

            // If not in database, try to get from WhatsApp
            const whatsappBot = this.bridge.getWhatsAppBot();
            if (whatsappBot && whatsappBot.sock) {
                const isGroup = jid.endsWith('@g.us');
                
                if (isGroup) {
                    try {
                        const groupMeta = await whatsappBot.sock.groupMetadata(jid);
                        return {
                            jid: jid,
                            name: groupMeta.subject,
                            phone: '',
                            isGroup: true,
                            groupName: groupMeta.subject
                        };
                    } catch (error) {
                        return { jid, name: 'Unknown Group', phone: '', isGroup: true };
                    }
                } else {
                    const phone = jid.split('@')[0];
                    try {
                        const contactInfo = await whatsappBot.sock.onWhatsApp(jid);
                        return {
                            jid: jid,
                            name: contactInfo[0]?.notify || phone,
                            phone: phone,
                            isGroup: false
                        };
                    } catch (error) {
                        return { jid, name: phone, phone: phone, isGroup: false };
                    }
                }
            }

            return { jid, name: 'Unknown', phone: jid.split('@')[0], isGroup: false };
            
        } catch (error) {
            logger.error('Failed to get contact info:', error);
            return { jid, name: 'Unknown', phone: jid.split('@')[0], isGroup: false };
        }
    }

    async handleContactCallback(query, data) {
        try {
            const [action, contactJid] = data.split('|');
            
            switch (action) {
                case 'info':
                    await this.showContactInfo(query, contactJid);
                    break;
                case 'block':
                    await this.blockContact(query, contactJid);
                    break;
                case 'unblock':
                    await this.unblockContact(query, contactJid);
                    break;
                default:
                    await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
                        text: '❌ Unknown contact action'
                    });
            }
        } catch (error) {
            logger.error('Failed to handle contact callback:', error);
        }
    }

    async showContactInfo(query, contactJid) {
        const database = this.bridge.getDatabase();
        const contact = await database.getContact(contactJid);
        
        if (!contact) {
            await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
                text: '❌ Contact not found'
            });
            return;
        }

        const infoText = `👤 *Contact Information*\n\n` +
                        `📝 Name: ${contact.name || 'Unknown'}\n` +
                        `📱 Phone: ${contact.phone}\n` +
                        `📊 Type: ${contact.isGroup ? '👥 Group' : '👤 Private'}\n` +
                        `💬 Messages: ${contact.messageCount}\n` +
                        `👋 First Seen: ${new Date(contact.firstSeen).toLocaleString()}\n` +
                        `📅 Last Active: ${new Date(contact.lastActive).toLocaleString()}\n` +
                        `🚫 Blocked: ${contact.isBlocked ? 'Yes' : 'No'}\n\n` +
                        `📝 Notes: ${contact.notes || 'None'}`;

        await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
            text: infoText,
            show_alert: true
        });
    }

    async blockContact(query, contactJid) {
        try {
            const database = this.bridge.getDatabase();
            await database.saveContact({ jid: contactJid, isBlocked: true });
            
            await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
                text: '🚫 Contact blocked'
            });
        } catch (error) {
            await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
                text: '❌ Failed to block contact'
            });
        }
    }

    async unblockContact(query, contactJid) {
        try {
            const database = this.bridge.getDatabase();
            await database.saveContact({ jid: contactJid, isBlocked: false });
            
            await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
                text: '✅ Contact unblocked'
            });
        } catch (error) {
            await this.bridge.getTelegramBot().answerCallbackQuery(query.id, {
                text: '❌ Failed to unblock contact'
            });
        }
    }
}

module.exports = ContactManager;
