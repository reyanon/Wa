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
                logChannel: '-1002287300661' // Same as chatId for logging, or a different channel ID
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
     * There is no file to save to, so this method is removed.
     * Any changes made via set() will be in-memory only and not persistent.
     */
    // save() {
    //     // Removed file saving logic
    // }

    /**
     * Retrieves a configuration value us
