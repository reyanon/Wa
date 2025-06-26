// No need for fs-extra or path as we are not reading/writing to a file
// const fs = require('fs-extra');
// const path = require('path');

class Config {
    constructor() {
        // No longer using configPath, as we don't save/load from settings.json
        // this.configPath = path.join(__dirname, 'settings.json'); 
        this.defaultConfig = {
            bot: {
                name: 'Raven',
                company: 'Kairox',
                prefix: '.',
                version: '2.0.0',
                owner: '923298784489@s.whatsapp.net' // Ensure owner is in JID format for WhatsApp
            },
            features: {
                mode: 'public', // public, private
                autoViewStatus: true,
                telegramBridge: true,
                customModules: true,
                rateLimiting: true
            },
            telegram: {
                enabled: true,
                botToken: '7580382614:AAH30PW6TFmgRzbC7HUXIHQ35GpndbJOIEI', // Your actual bot token
                chatId: '-1002287300661', // Your actual group chat ID
                useTopics: true, // Set to false if your group doesn't use topics
                logChannel: '-1002287300661', // Same as chatId for logging, or a different channel I
                settings: {
                    allowMedia: true,
                    allowStickers: true,
                    allowVoice: true,
                    allowAudio: true,
                    allowDocuments: true,
                    allowVideos: true,
                    syncContacts: true,
                    syncStatus: true,
                    syncCalls: true,
                    autoUpdateProfilePics: true,
                    bridgeEnabled: true
                }
            },
            database: {
                mongodb: {
                    enabled: true,
                    uri: 'mongodb://localhost:27017/whatsapp-bridge',
                    options: {
                        useNewUrlParser: true,
                        useUnifiedTopology: true
                    }
                }
            },
            apis: {
                ninjas: 'Fcc7UUfjRmEY0Q7jTUB5LQ==LJMBB9ING3SRvOrg',
                weather: '6e9efe905e8b3a81b6704dd2b960c156',
                translate: ''
            },
            security: {
                maxCommandsPerMinute: 10,
                maxDownloadsPerHour: 20,
                allowedDomains: ['youtube.com', 'instagram.com', 'tiktok.com'],
                blockedUsers: []
            },
            logging: {
                level: 'info', // Set to 'debug' during development to see all logs
                saveToFile: true,
                maxFileSize: '10MB',
                maxFiles: 5
            }
        };
        // Directly load the default config into this.config
        this.load(); 
    }

    /**
     * Loads the default configuration into the active config.
     * With no settings.json, this simply uses the hardcoded defaultConfig.
     */
    load() {
        // The config is directly the default config now.
        this.config = { ...this.defaultConfig };
        console.log('Configuration loaded from defaultConfig in config.js.');
    }

    /**
     * Retrieves a configuration value using a dot-separated key (e.g., 'telegram.botToken').
     * @param {string} key - The dot-separated key to retrieve.
     * @returns {*} The configuration value.
     */
    get(key) {
        return key.split('.').reduce((o, k) => o && o[k], this.config);
    }

    /**
     * Sets a configuration value.
     * WARNING: Changes made via this method are in-memory only and will NOT persist
     * across bot restarts since settings.json is no longer used.
     * @param {string} key - The dot-separated key to set.
     * @param {*} value - The value to set.
     */
    set(key, value) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        // Traverse the config object to find the target object
        const target = keys.reduce((o, k) => {
            // If any part of the path doesn't exist, create it as an empty object
            if (typeof o[k] === 'undefined' || o[k] === null) {
                o[k] = {};
            }
            return o[k];
        }, this.config);
        
        // Set the value on the target object
        target[lastKey] = value;
        console.warn(`Config key '${key}' was set to '${value}' in memory. This change is NOT persistent across restarts.`);
        // Removed this.save() as there's no file to save to
    }

    /**
     * Updates multiple configuration values.
     * WARNING: Changes made via this method are in-memory only and will NOT persist
     * across bot restarts since settings.json is no longer used.
     * @param {object} updates - An object containing key-value pairs of updates.
     */
    update(updates) {
        // Simple merge, more complex deep merge might be needed for nested objects
        this.config = { ...this.config, ...updates };
        console.warn('Configuration was updated in memory. These changes are NOT persistent across restarts.');
        // Removed this.save() as there's no file to save to
    }
}

// Export a singleton instance of the Config class
module.exports = new Config();




const fs = require('fs-extra');
const path = require('path');

class Config {
    constructor() {
        this.configPath = path.join(__dirname, 'settings.json');
        this.defaultConfig = {
            bot: {
                name: 'Raven',
                company: 'Kairox',
                prefix: '.',
                version: '2.0.0',
                owner: null
            },
            features: {
                mode: 'public', // public, private
                autoViewStatus: true,
                telegramBridge: true,
                customModules: true,
                rateLimiting: true
            },
            telegram: {
                enabled: true,
                botToken: '7902063409:AAGJhJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
                chatId: '-1002345678901',
                useTopics: true,
                logChannel: '-1002345678901',
                settings: {
                    allowMedia: true,
                    allowStickers: true,
                    allowVoice: true,
                    allowAudio: true,
                    allowDocuments: true,
                    allowVideos: true,
                    syncContacts: true,
                    syncStatus: true,
                    syncCalls: true,
                    autoUpdateProfilePics: true,
                    bridgeEnabled: true
                }
            },
            database: {
                mongodb: {
                    enabled: true,
                    uri: 'mongodb://localhost:27017/whatsapp-bridge',
                    options: {
                        useNewUrlParser: true,
                        useUnifiedTopology: true
                    }
                }
            },
            apis: {
                ninjas: 'Fcc7UUfjRmEY0Q7jTUB5LQ==LJMBB9ING3SRvOrg',
                weather: '6e9efe905e8b3a81b6704dd2b960c156',
                translate: ''
            },
            security: {
                maxCommandsPerMinute: 10,
                maxDownloadsPerHour: 20,
                allowedDomains: ['youtube.com', 'instagram.com', 'tiktok.com'],
                blockedUsers: []
            },
            logging: {
                level: 'info',
                saveToFile: true,
                maxFileSize: '10MB',
                maxFiles: 5
            }
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = fs.readJsonSync(this.configPath);
                this.config = { ...this.defaultConfig, ...data };
            } else {
                this.config = { ...this.defaultConfig };
                this.save();
            }
        } catch (error) {
            console.error('Error loading config:', error);
            this.config = { ...this.defaultConfig };
        }
    }

    save() {
        try {
            fs.writeJsonSync(this.configPath, this.config, { spaces: 2 });
        } catch (error) {
            console.error('Error saving config:', error);
        }
    }

    get(key) {
        return key.split('.').reduce((o, k) => o && o[k], this.config);
    }

    set(key, value) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        const target = keys.reduce((o, k) => o[k] = o[k] || {}, this.config);
        target[lastKey] = value;
        this.save();
    }

    update(updates) {
        this.config = { ...this.config, ...updates };
        this.save();
    }
}

module.exports = new Config();
