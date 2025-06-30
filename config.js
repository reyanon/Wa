class Config {
    constructor() {
        this.defaultConfig = {
            bot: {
                name: 'NexusWA',
                company: 'Dawium Technologies',
                prefix: '.',
                version: '2.0.0',
                owner: '923298784489@s.whatsapp.net',
                clearAuthOnStart: false // debug only
            },
            features: {
                mode: 'public', // public or private
                autoViewStatus: true,
                customModules: true,
                rateLimiting: true,
                telegramBridge: true
            },
            mongo: {
                uri: 'mongodb+srv://itxelijah07:ivp8FYGsbVfjQOkj@cluster0.wh25x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
                dbName: 'advancedwa'
            },
            apis: {
                ninjas: 'YOUR_API_KEY',
                weather: 'YOUR_WEATHER_KEY',
                translate: ''
            },
            security: {
                maxCommandsPerMinute: 10,
                maxDownloadsPerHour: 20,
                allowedDomains: ['youtube.com', 'instagram.com', 'tiktok.com'],
                blockedUsers: []
            },
            telegram: {
                enabled: true,
                botToken: '7580382614:AAH30PW6TFmgRzbC7HUXIHQ35GpndbJOIEI',
                chatId: '-1002287300661',
                adminIds: [7580382614],
                sudoUsers: [7580382614],
                features: {
                    topics: true,
                    mediaSync: true,
                    profilePicSync: true,
                    callLogs: true,
                    statusSync: true,
                    biDirectional: true
                }
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
        this.config = { ...this.defaultConfig };
        console.log('✅ Configuration loaded');
    }

    get(key) {
        return key.split('.').reduce((o, k) => o && o[k], this.config);
    }

    set(key, value) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        const target = keys.reduce((o, k) => {
            if (typeof o[k] === 'undefined') o[k] = {};
            return o[k];
        }, this.config);
        target[lastKey] = value;
        console.warn(`⚠️ Config key '${key}' was set to '${value}' (in-memory only).`);
    }

    update(updates) {
        this.config = { ...this.config, ...updates };
        console.warn('⚠️ Config was updated in memory. Not persistent.');
    }
}

module.exports = new Config();
