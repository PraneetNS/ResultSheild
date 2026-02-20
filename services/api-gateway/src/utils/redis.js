const { createClient } = require('redis');
const logger = require('./logger');
// Metrics are imported lazily to avoid circular dependency at module load time
function getMetrics() {
    try { return require('./metrics').metrics; } catch { return null; }
}

let redisClient = null;

/**
 * Initialize Redis connection
 */
async function initializeRedis() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    redisClient = createClient({
        url: redisUrl,
        socket: {
            reconnectStrategy: (retries) => {
                if (retries > 10) {
                    logger.error('Redis reconnection failed after 10 attempts');
                    return new Error('Redis reconnection limit exceeded');
                }
                return Math.min(retries * 100, 3000);
            }
        }
    });

    redisClient.on('error', (err) => {
        logger.error('Redis client error', { error: err.message });
    });

    redisClient.on('connect', () => {
        logger.info('Redis client connected');
    });

    redisClient.on('reconnecting', () => {
        logger.warn('Redis client reconnecting');
    });

    await redisClient.connect();

    return redisClient;
}

/**
 * Get Redis client instance
 */
function getRedisClient() {
    if (!redisClient) {
        throw new Error('Redis client not initialized. Call initializeRedis() first.');
    }

    // Add custom helper for atomic INCR + EXPIRE if not already present
    if (!redisClient.incrEx) {
        redisClient.incrEx = async (key, ttl) => {
            const multi = redisClient.multi();
            multi.incr(key);
            multi.expire(key, ttl);
            const results = await multi.exec();
            return results[0]; // Return the result of INCR
        };
    }

    return redisClient;
}

/**
 * Token Bucket Rate Limiter using Redis
 */
class TokenBucketRateLimiter {
    constructor(options = {}) {
        this.capacity = options.capacity || 100;
        this.refillRate = options.refillRate || 10; // tokens per second
        this.windowSize = options.windowSize || 60; // seconds
    }

    /**
     * Check if request is allowed
     * @param {string} key - Unique identifier (e.g., user ID, IP)
     * @param {number} overrideCapacity - Optional capacity override
     * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
     */
    async consume(key, overrideCapacity = null) {
        const client = getRedisClient();
        const now = Date.now();
        const bucketKey = `rate_limit:${key}`;
        const currentCapacity = overrideCapacity || this.capacity;

        try {
            // Get current bucket state
            const bucketData = await client.get(bucketKey);

            let tokens, lastRefill;

            if (bucketData) {
                const parsed = JSON.parse(bucketData);
                tokens = parsed.tokens;
                lastRefill = parsed.lastRefill;

                // Calculate tokens to add based on time elapsed
                const elapsed = (now - lastRefill) / 1000;
                const tokensToAdd = Math.floor(elapsed * this.refillRate);
                tokens = Math.min(currentCapacity, tokens + tokensToAdd);
                lastRefill = tokensToAdd > 0 ? now : lastRefill;
            } else {
                // Initialize new bucket
                tokens = currentCapacity;
                lastRefill = now;
            }

            // Check if request can be allowed
            if (tokens >= 1) {
                tokens -= 1;

                // Save updated bucket state
                await client.setEx(
                    bucketKey,
                    this.windowSize,
                    JSON.stringify({ tokens, lastRefill })
                );

                return {
                    allowed: true,
                    remaining: Math.floor(tokens),
                    resetAt: lastRefill + (this.windowSize * 1000)
                };
            } else {
                return {
                    allowed: false,
                    remaining: 0,
                    resetAt: lastRefill + (this.windowSize * 1000)
                };
            }
        } catch (error) {
            logger.error('Rate limiter error', { error: error.message, key });
            // Fail open - allow request if Redis is down
            return { allowed: true, remaining: -1, resetAt: now };
        }
    }

    /**
     * Reset rate limit for a key
     */
    async reset(key) {
        const client = getRedisClient();
        await client.del(`rate_limit:${key}`);
    }
}

/**
 * Cache helper functions
 */
const cache = {
    /**
     * Get value from cache
     */
    async get(key) {
        const m = getMetrics();
        const start = process.hrtime.bigint();
        try {
            const client = getRedisClient();
            const value = await client.get(key);
            const dur = Number(process.hrtime.bigint() - start) / 1e9;
            if (m) {
                m.redisLatencySeconds.labels({ service: 'api-gateway', operation: 'get' }).observe(dur);
                if (value) {
                    m.redisCacheHitsTotal.labels({ service: 'api-gateway', cache_type: 'result' }).inc();
                } else {
                    m.redisCacheMissesTotal.labels({ service: 'api-gateway', cache_type: 'result' }).inc();
                }
            }
            return value ? JSON.parse(value) : null;
        } catch (error) {
            logger.error('Cache get error', { error: error.message, key });
            return null;
        }
    },

    /**
     * Set value in cache with TTL
     */
    async set(key, value, ttl = 3600) {
        const m = getMetrics();
        const start = process.hrtime.bigint();
        try {
            const client = getRedisClient();
            await client.setEx(key, ttl, JSON.stringify(value));
            const dur = Number(process.hrtime.bigint() - start) / 1e9;
            if (m) m.redisLatencySeconds.labels({ service: 'api-gateway', operation: 'set' }).observe(dur);
            return true;
        } catch (error) {
            logger.error('Cache set error', { error: error.message, key });
            return false;
        }
    },

    /**
     * Delete key from cache
     */
    async del(key) {
        try {
            const client = getRedisClient();
            await client.del(key);
            return true;
        } catch (error) {
            logger.error('Cache delete error', { error: error.message, key });
            return false;
        }
    },

    /**
     * Check if key exists
     */
    async exists(key) {
        try {
            const client = getRedisClient();
            return await client.exists(key) === 1;
        } catch (error) {
            logger.error('Cache exists error', { error: error.message, key });
            return false;
        }
    },

    /**
     * Increment counter
     */
    async incr(key, ttl = null) {
        try {
            const client = getRedisClient();
            const value = await client.incr(key);
            if (ttl && value === 1) {
                await client.expire(key, ttl);
            }
            return value;
        } catch (error) {
            logger.error('Cache incr error', { error: error.message, key });
            return 0;
        }
    }
};

module.exports = {
    initializeRedis,
    getRedisClient,
    TokenBucketRateLimiter,
    cache
};
