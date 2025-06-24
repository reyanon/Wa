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
                owner: 923298784489
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
                botToken: '7902063409:AAGJhJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ', // Replace with your bot token
                chatId: '-1002345678901', // Replace with your group chat ID
                useTopics: true,
                logChannel: '-1002345678901' // Same as chatId for logging
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
