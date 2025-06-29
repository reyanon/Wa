module.exports = {
    // Message sync configuration
    sync: {
        // Enable/disable message syncing
        enabled: true,
        
        // Include messages sent by the bot itself
        includeSelfMessages: false,
        
        // Chats to ignore (JIDs)
        ignoredChats: [
            // Add chat JIDs to ignore
            // 'status@broadcast',
            // '1234567890@s.whatsapp.net'
        ],
        
        // Message types to sync
        messageTypes: {
            text: true,
            image: true,
            video: true,
            audio: true,
            document: true,
            sticker: true,
            location: true,
            contact: true,
            reaction: true,
            poll: false // Polls are complex, disabled by default
        },
        
        // Media handling
        media: {
            // Maximum file size to sync (in bytes)
            maxFileSize: 50 * 1024 * 1024, // 50MB
            
            // Download timeout (in milliseconds)
            downloadTimeout: 30000, // 30 seconds
            
            // Supported media types
            supportedTypes: [
                'image/jpeg', 'image/png', 'image/gif', 'image/webp',
                'video/mp4', 'video/avi', 'video/mov', 'video/webm',
                'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a',
                'application/pdf', 'application/msword', 'text/plain'
            ]
        },
        
        // Queue settings
        queue: {
            // Maximum number of messages in queue
            maxSize: 1000,
            
            // Maximum retry attempts for failed messages
            maxRetries: 3,
            
            // Delay between retry attempts (in milliseconds)
            retryDelay: 5000, // 5 seconds
            
            // Process queue interval (in milliseconds)
            processInterval: 1000 // 1 second
        },
        
        // Telegram sync settings
        telegram: {
            // Enable Telegram sync
            enabled: true,
            
            // Chat ID for synced messages
            targetChatId: null, // Set this to your Telegram chat ID
            
            // Message format template
            messageTemplate: {
                text: '📱 *WhatsApp Message*\n\nFrom: {sender}\nChat: {chat}\nTime: {time}\n\n{content}',
                media: '📱 *WhatsApp {mediaType}*\n\nFrom: {sender}\nChat: {chat}\nTime: {time}\n\n{caption}'
            },
            
            // Include message metadata
            includeMetadata: true,
            
            // Forward as files or embed
            forwardAsFiles: true
        },
        
        // Logging settings
        logging: {
            // Log all sync attempts
            logAllAttempts: true,
            
            // Log successful syncs
            logSuccessful: true,
            
            // Log failed syncs
            logFailed: true,
            
            // Log detailed message structure
            logMessageStructure: true,
            
            // Log media download attempts
            logMediaDownloads: true
        }
    }
};
