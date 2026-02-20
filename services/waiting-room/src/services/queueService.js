const queueRepository = require('./queueRepository');
const accessController = require('./accessController');
const logger = require('../utils/logger');
const { recordMetric, updateQueueGauges } = require('../utils/metrics');
const { broadcastToAll } = require('../utils/websocketServer');

// Configuration
const MAX_ACTIVE_SESSIONS = parseInt(process.env.MAX_ACTIVE_SESSIONS) || 1000;
const THROUGHPUT_PER_SECOND = parseInt(process.env.THROUGHPUT_PER_SECOND) || 100;
const AVG_SESSION_DURATION = parseInt(process.env.AVG_SESSION_DURATION) || 60; // seconds

/**
 * Check if user should enter queue or get immediate access
 */
async function checkAccess(userId) {
    try {
        // Check if user already has active session
        const hasSession = await queueRepository.hasActiveSession(userId);
        if (hasSession) {
            logger.info('User has active session', { userId });
            return {
                allowed: true,
                reason: 'active_session',
                token: accessController.generateAccessToken(userId)
            };
        }

        // Check if user is already in queue
        const queuePosition = await queueRepository.getQueuePosition(userId);
        if (queuePosition !== null) {
            const estimatedWait = calculateEstimatedWait(queuePosition);

            logger.info('User already in queue', { userId, queuePosition });
            return {
                allowed: false,
                inQueue: true,
                queuePosition,
                estimatedWaitTime: estimatedWait,
                retryAfter: calculateRetryAfter(queuePosition)
            };
        }

        // Check current load
        const activeSessions = await queueRepository.getActiveSessionsCount();

        if (activeSessions < MAX_ACTIVE_SESSIONS) {
            // Grant immediate access
            await queueRepository.addToActiveSessions(
                userId,
                accessController.getTokenExpirySeconds()
            );

            const token = accessController.generateAccessToken(userId);

            logger.info('Immediate access granted', { userId, activeSessions });
            recordMetric('immediate_access_granted', 1);

            // Update Prometheus gauges (non-blocking)
            queueRepository.getQueueStats().then(s => {
                updateQueueGauges(s.queueLength, 0, s.activeSessions);
            }).catch(() => { });

            return {
                allowed: true,
                reason: 'immediate_access',
                token,
                expiresIn: accessController.getTokenExpirySeconds()
            };
        }

        // System at capacity - add to queue
        await queueRepository.addToQueue(userId);
        const newPosition = await queueRepository.getQueuePosition(userId);
        const estimatedWait = calculateEstimatedWait(newPosition);

        logger.info('User added to queue', { userId, position: newPosition });
        recordMetric('users_queued', 1);

        // Update Prometheus gauges (non-blocking)
        queueRepository.getQueueStats().then(s => {
            updateQueueGauges(s.queueLength, estimatedWait, s.activeSessions);
        }).catch(() => { });

        return {
            allowed: false,
            inQueue: true,
            queuePosition: newPosition,
            estimatedWaitTime: estimatedWait,
            retryAfter: calculateRetryAfter(newPosition)
        };

    } catch (error) {
        logger.error('Error checking access', { userId, error: error.message });

        // Graceful degradation - allow access if Redis fails
        logger.warn('Degraded mode: allowing access due to error', { userId });
        recordMetric('degraded_mode_access', 1);

        return {
            allowed: true,
            reason: 'degraded_mode',
            token: accessController.generateAccessToken(userId),
            warning: 'System in degraded mode'
        };
    }
}

/**
 * Check queue status for user
 */
async function checkQueueStatus(userId) {
    try {
        // Check if user has active session
        const hasSession = await queueRepository.hasActiveSession(userId);
        if (hasSession) {
            return {
                status: 'active',
                message: 'You have an active session',
                token: accessController.generateAccessToken(userId)
            };
        }

        // Check queue position
        const queuePosition = await queueRepository.getQueuePosition(userId);

        if (queuePosition === null) {
            return {
                status: 'not_in_queue',
                message: 'You are not in the queue'
            };
        }

        const estimatedWait = calculateEstimatedWait(queuePosition);

        // Check if user is next in line
        if (queuePosition === 1) {
            const activeSessions = await queueRepository.getActiveSessionsCount();

            if (activeSessions < MAX_ACTIVE_SESSIONS) {
                // Grant access
                await queueRepository.removeFromQueue(userId);
                await queueRepository.addToActiveSessions(
                    userId,
                    accessController.getTokenExpirySeconds()
                );

                const token = accessController.generateAccessToken(userId);

                logger.info('Access granted from queue', { userId });
                recordMetric('queue_access_granted', 1);

                return {
                    status: 'granted',
                    message: 'Access granted!',
                    token,
                    expiresIn: accessController.getTokenExpirySeconds()
                };
            }
        }

        return {
            status: 'queued',
            queuePosition,
            estimatedWaitTime: estimatedWait,
            retryAfter: calculateRetryAfter(queuePosition),
            message: `You are #${queuePosition} in queue`
        };

    } catch (error) {
        logger.error('Error checking queue status', { userId, error: error.message });
        throw error;
    }
}

/**
 * Release user session (when they're done)
 */
async function releaseSession(userId) {
    try {
        await queueRepository.removeFromActiveSessions(userId);
        logger.info('Session released', { userId });
        recordMetric('sessions_released', 1);

        // Process next in queue
        await processQueue();

        // Notify all WebSocket clients of potential position changes
        broadcastToAll();

        // Update Prometheus gauges (non-blocking)
        queueRepository.getQueueStats().then(s => {
            updateQueueGauges(s.queueLength, 0, s.activeSessions);
        }).catch(() => { });

        return true;
    } catch (error) {
        logger.error('Error releasing session', { userId, error: error.message });
        throw error;
    }
}

/**
 * Process queue - grant access to next users if capacity available
 */
async function processQueue() {
    try {
        const activeSessions = await queueRepository.getActiveSessionsCount();
        const availableSlots = MAX_ACTIVE_SESSIONS - activeSessions;

        if (availableSlots <= 0) {
            return 0;
        }

        let processed = 0;
        for (let i = 0; i < Math.min(availableSlots, THROUGHPUT_PER_SECOND); i++) {
            const userId = await queueRepository.popNextFromQueue();

            if (!userId) {
                break; // Queue empty
            }

            await queueRepository.addToActiveSessions(
                userId,
                accessController.getTokenExpirySeconds()
            );

            processed++;
        }

        if (processed > 0) {
            logger.info('Processed queue', { count: processed });
            recordMetric('queue_processed', processed);
        }

        return processed;
    } catch (error) {
        logger.error('Error processing queue', { error: error.message });
        return 0;
    }
}

/**
 * Calculate estimated wait time based on queue position
 */
function calculateEstimatedWait(position) {
    if (position <= 0) return 0;

    // Estimate based on throughput and average session duration
    const waitTime = Math.ceil((position / THROUGHPUT_PER_SECOND) * AVG_SESSION_DURATION);

    return waitTime;
}

/**
 * Calculate retry-after time with exponential backoff
 */
function calculateRetryAfter(position) {
    if (position <= 10) return 5; // 5 seconds for top 10
    if (position <= 50) return 10; // 10 seconds for top 50
    if (position <= 100) return 15; // 15 seconds for top 100
    if (position <= 500) return 30; // 30 seconds for top 500

    return 60; // 60 seconds for everyone else
}

/**
 * Get queue metrics
 */
async function getMetrics() {
    try {
        const stats = await queueRepository.getQueueStats();

        let avgWait = 0;
        if (stats.oldestTimestamp) {
            const waitMs = Date.now() - stats.oldestTimestamp;
            avgWait = Math.ceil(waitMs / 1000);
        }

        // Keep Prometheus gauges in sync
        updateQueueGauges(stats.queueLength, avgWait, stats.activeSessions);

        return {
            queueLength: stats.queueLength,
            activeSessions: stats.activeSessions,
            maxSessions: MAX_ACTIVE_SESSIONS,
            utilizationPercent: Math.round((stats.activeSessions / MAX_ACTIVE_SESSIONS) * 100),
            averageWaitTime: avgWait,
            throughputPerSecond: THROUGHPUT_PER_SECOND
        };
    } catch (error) {
        logger.error('Error getting metrics', { error: error.message });
        throw error;
    }
}

/**
 * Cleanup job - remove expired sessions and process queue
 */
async function cleanupJob() {
    try {
        await queueRepository.cleanupExpiredSessions();
        const processed = await processQueue();

        // If anyone was promoted, notify all WebSocket clients
        broadcastToAll();
    } catch (error) {
        logger.error('Cleanup job failed', { error: error.message });
    }
}

// Start cleanup job (runs every 10 seconds)
setInterval(cleanupJob, 10000);

module.exports = {
    checkAccess,
    checkQueueStatus,
    releaseSession,
    processQueue,
    getMetrics,
    cleanupJob
};
