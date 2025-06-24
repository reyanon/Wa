const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('./logger');

class RateLimiter {
    constructor() {
        this.commandLimiter = new RateLimiterMemory({
            keyGenerator: (user) => user,
            points: 10, // Number of commands
            duration: 60, // Per 60 seconds
        });

        this.downloadLimiter = new RateLimiterMemory({
            keyGenerator: (user) => user,
            points: 5, // Number of downloads
            duration: 3600, // Per hour
        });
    }

    async checkCommandLimit(userId) {
        try {
            await this.commandLimiter.consume(userId);
            return true;
        } catch (rejRes) {
            logger.warn(`Rate limit exceeded for user ${userId}: ${rejRes.msBeforeNext}ms remaining`);
            return false;
        }
    }

    async checkDownloadLimit(userId) {
        try {
            await this.downloadLimiter.consume(userId);
            return true;
        } catch (rejRes) {
            logger.warn(`Download limit exceeded for user ${userId}: ${rejRes.msBeforeNext}ms remaining`);
            return false;
        }
    }

    async getRemainingTime(userId, type = 'command') {
        try {
            const limiter = type === 'download' ? this.downloadLimiter : this.commandLimiter;
            const res = await limiter.get(userId);
            return res ? res.msBeforeNext : 0;
        } catch (error) {
            return 0;
        }
    }
}

module.exports = new RateLimiter();