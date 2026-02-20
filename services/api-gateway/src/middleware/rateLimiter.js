/**
 * Rate Limiting Middleware (Phase 7 Enhanced)
 *
 * Uses Token Bucket algorithm with support for adaptive multipliers.
 */

const { TokenBucketRateLimiter } = require('../utils/redis');
const logger = require('../utils/logger');
const { metrics } = require('../utils/metrics');

// Configuration constants
const DEFAULT_CAPACITY = parseInt(process.env.RATE_LIMIT_REQUESTS) || 100;
const DEFAULT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 60;

// Initialize rate limiters
// User-level bucket
const userRateLimiter = new TokenBucketRateLimiter({
    capacity: DEFAULT_CAPACITY,
    refillRate: 10,
    windowSize: DEFAULT_WINDOW
});

// Global system-wide bucket (safety valve)
const globalRateLimiter = new TokenBucketRateLimiter({
    capacity: 10000,
    refillRate: 1000,
    windowSize: 60
});

/**
 * Rate limiting middleware
 */
async function rateLimiter(req, res, next) {
    try {
        const requestId = req.requestId || 'unknown';
        const identifier = req.headers['x-user-id'] || req.ip;

        // 1. Check Global Rate Limit first
        const globalLimit = await globalRateLimiter.consume('global');

        if (!globalLimit.allowed) {
            logger.warn('Global rate limit exceeded - System Overload', { requestId, path: req.path });
            metrics.rateLimitExceededTotal.labels({ service: 'api-gateway', limit_type: 'global' }).inc();

            return res.status(429).json({
                error: 'Too Many Requests',
                message: 'System is experiencing high load. Please try again later.',
                retryAfter: Math.ceil((globalLimit.resetAt - Date.now()) / 1000),
                requestId
            });
        }

        // 2. Determine Capacity with Adaptive Multiplier
        // req.adaptiveMultiplier is provided by adaptiveLimiter.js middleware
        const multiplier = req.adaptiveMultiplier || 1.0;
        const currentCapacity = Math.max(1, Math.floor(DEFAULT_CAPACITY * multiplier));

        // 3. User-specific Rate Limit check
        const userLimit = await userRateLimiter.consume(identifier, currentCapacity);

        // 4. Set Response Headers
        res.setHeader('X-RateLimit-Limit', currentCapacity);
        res.setHeader('X-RateLimit-Remaining', userLimit.remaining);
        res.setHeader('X-RateLimit-Reset', new Date(userLimit.resetAt).toISOString());
        res.setHeader('X-RateLimit-Multiplier', multiplier.toFixed(2));

        if (!userLimit.allowed) {
            logger.warn('User rate limit exceeded', {
                requestId,
                identifier,
                path: req.path,
                multiplier,
                capacity: currentCapacity
            });

            metrics.rateLimitExceededTotal.labels({ service: 'api-gateway', limit_type: 'user' }).inc();

            return res.status(429).json({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Please slow down.',
                retryAfter: Math.ceil((userLimit.resetAt - Date.now()) / 1000),
                requestId
            });
        }

        // Continue to business logic
        next();
    } catch (error) {
        logger.error('Rate limiter middleware error', { requestId: req.requestId, error: error.message });
        // Fail open - let request through if rate limiting logic errors out
        next();
    }
}

module.exports = rateLimiter;
