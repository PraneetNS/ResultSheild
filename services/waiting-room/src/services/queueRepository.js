const { createClient } = require('redis');
const logger = require('../utils/logger');

let redisClient = null;

// Queue configuration
const QUEUE_KEY = 'waiting_room:queue';
const ACTIVE_SESSIONS_KEY = 'waiting_room:active_sessions';
const USER_TOKEN_PREFIX = 'waiting_room:user:';

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
                    return new Error('Redis reconnection failed');
                }
                return Math.min(retries * 100, 3000);
            }
        }
    });

    redisClient.on('error', (err) => {
        logger.error('Redis error', { error: err.message });
    });

    redisClient.on('connect', () => {
        logger.info('Redis connected');
    });

    await redisClient.connect();
    return redisClient;
}

/**
 * Get Redis client
 */
function getRedisClient() {
    if (!redisClient || !redisClient.isOpen) {
        throw new Error('Redis client not initialized or disconnected');
    }
    return redisClient;
}

/**
 * Add user to queue (FIFO using sorted set with timestamp as score)
 */
async function addToQueue(userId) {
    try {
        const client = getRedisClient();
        const timestamp = Date.now();

        // Add to sorted set with timestamp as score (FIFO)
        await client.zAdd(QUEUE_KEY, {
            score: timestamp,
            value: userId
        });

        logger.info('User added to queue', { userId, timestamp });
        return timestamp;
    } catch (error) {
        logger.error('Failed to add user to queue', { userId, error: error.message });
        throw error;
    }
}

/**
 * Get user's position in queue
 */
async function getQueuePosition(userId) {
    try {
        const client = getRedisClient();

        // Get rank (0-indexed, so add 1 for position)
        const rank = await client.zRank(QUEUE_KEY, userId);

        if (rank === null) {
            return null; // User not in queue
        }

        return rank + 1; // Convert to 1-indexed position
    } catch (error) {
        logger.error('Failed to get queue position', { userId, error: error.message });
        throw error;
    }
}

/**
 * Get total queue length
 */
async function getQueueLength() {
    try {
        const client = getRedisClient();
        return await client.zCard(QUEUE_KEY);
    } catch (error) {
        logger.error('Failed to get queue length', { error: error.message });
        throw error;
    }
}

/**
 * Remove user from queue
 */
async function removeFromQueue(userId) {
    try {
        const client = getRedisClient();
        const removed = await client.zRem(QUEUE_KEY, userId);

        if (removed > 0) {
            logger.info('User removed from queue', { userId });
        }

        return removed > 0;
    } catch (error) {
        logger.error('Failed to remove user from queue', { userId, error: error.message });
        throw error;
    }
}

/**
 * Pop next user from queue (FIFO)
 */
async function popNextFromQueue() {
    try {
        const client = getRedisClient();

        // Get and remove the lowest score (oldest timestamp)
        const result = await client.zPopMin(QUEUE_KEY);

        if (!result) {
            return null;
        }

        logger.info('User popped from queue', { userId: result.value });
        return result.value;
    } catch (error) {
        logger.error('Failed to pop from queue', { error: error.message });
        throw error;
    }
}

/**
 * Get current active sessions count
 */
async function getActiveSessionsCount() {
    try {
        const client = getRedisClient();
        return await client.sCard(ACTIVE_SESSIONS_KEY);
    } catch (error) {
        logger.error('Failed to get active sessions count', { error: error.message });
        throw error;
    }
}

/**
 * Add user to active sessions
 */
async function addToActiveSessions(userId, ttl = 300) {
    try {
        const client = getRedisClient();

        // Add to set
        await client.sAdd(ACTIVE_SESSIONS_KEY, userId);

        // Set expiry on user's session key
        const userKey = `${USER_TOKEN_PREFIX}${userId}`;
        await client.set(userKey, 'active', { EX: ttl });

        logger.info('User added to active sessions', { userId, ttl });
        return true;
    } catch (error) {
        logger.error('Failed to add to active sessions', { userId, error: error.message });
        throw error;
    }
}

/**
 * Remove user from active sessions
 */
async function removeFromActiveSessions(userId) {
    try {
        const client = getRedisClient();

        await client.sRem(ACTIVE_SESSIONS_KEY, userId);

        const userKey = `${USER_TOKEN_PREFIX}${userId}`;
        await client.del(userKey);

        logger.info('User removed from active sessions', { userId });
        return true;
    } catch (error) {
        logger.error('Failed to remove from active sessions', { userId, error: error.message });
        throw error;
    }
}

/**
 * Check if user has active session
 */
async function hasActiveSession(userId) {
    try {
        const client = getRedisClient();
        return await client.sIsMember(ACTIVE_SESSIONS_KEY, userId);
    } catch (error) {
        logger.error('Failed to check active session', { userId, error: error.message });
        throw error;
    }
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
    try {
        const client = getRedisClient();

        const queueLength = await client.zCard(QUEUE_KEY);
        const activeSessions = await client.sCard(ACTIVE_SESSIONS_KEY);

        // Get oldest entry timestamp for average wait time calculation
        let oldestTimestamp = null;
        if (queueLength > 0) {
            const oldest = await client.zRange(QUEUE_KEY, 0, 0, { WITHSCORES: true });
            if (oldest && oldest.length > 0) {
                oldestTimestamp = oldest[0].score;
            }
        }

        return {
            queueLength,
            activeSessions,
            oldestTimestamp
        };
    } catch (error) {
        logger.error('Failed to get queue stats', { error: error.message });
        throw error;
    }
}

/**
 * Clear expired sessions (cleanup job)
 */
/**
 * Clear expired sessions and abandoned queue entries (cleanup job)
 */
async function cleanupExpiredSessions() {
    try {
        const client = getRedisClient();

        // 1. Cleanup expired active sessions
        const userIds = await client.sMembers(ACTIVE_SESSIONS_KEY);
        let sessionsCleaned = 0;
        for (const userId of userIds) {
            const userKey = `${USER_TOKEN_PREFIX}${userId}`;
            const exists = await client.exists(userKey);
            if (!exists) {
                await client.sRem(ACTIVE_SESSIONS_KEY, userId);
                sessionsCleaned++;
            }
        }

        // 2. Cleanup abandoned queue entries (older than 1 hour)
        const oneHourAgo = Date.now() - 3600000;
        const queueCleaned = await client.zRemRangeByScore(QUEUE_KEY, '-inf', oneHourAgo);

        if (sessionsCleaned > 0 || queueCleaned > 0) {
            logger.info('Cleanup job results', {
                sessionsCleaned,
                queueCleaned
            });
        }

        return sessionsCleaned + queueCleaned;
    } catch (error) {
        logger.error('Failed to cleanup expired sessions', { error: error.message });
        throw error;
    }
}

module.exports = {
    initializeRedis,
    getRedisClient,
    addToQueue,
    getQueuePosition,
    getQueueLength,
    removeFromQueue,
    popNextFromQueue,
    getActiveSessionsCount,
    addToActiveSessions,
    removeFromActiveSessions,
    hasActiveSession,
    getQueueStats,
    cleanupExpiredSessions
};
