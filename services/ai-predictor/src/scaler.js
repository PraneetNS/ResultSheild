const logger = require('./logger');
const { createClient } = require('redis');
const config = require('./config');
const { metrics } = require('./metrics');

/**
 * Pre-scaling Orchestrator (Phase 8)
 * 
 * Simulates scaling operations based on traffic predictions.
 */

let redisClient = null;

async function getRedis() {
    if (!redisClient) {
        redisClient = createClient({ url: config.REDIS_URL });
        await redisClient.connect();
    }
    return redisClient;
}

async function triggerPreScaling(predictedRps, reason) {
    try {
        const redis = await getRedis();
        const currentScale = parseInt(await redis.get('system:scale:result-service')) || 1;

        // Logic: For every 50 predicted RPS above threshold, add 1 replica (up to 5)
        const targetScale = Math.min(5, Math.max(1, Math.ceil(predictedRps / 50)));

        if (targetScale > currentScale) {
            logger.info('🚀 PRE-SCALING TRIGGERED', {
                reason,
                predictedRps,
                oldScale: currentScale,
                newScale: targetScale,
                action: `docker-compose up -d --scale result-service=${targetScale}`
            });

            await redis.set('system:scale:result-service', targetScale);
            await redis.set('system:scaling:event', JSON.stringify({
                timestamp: Date.now(),
                type: 'PRE_SCALE_UP',
                target: targetScale,
                reason
            }));

            metrics.prescalingTriggeredTotal.inc();
        } else {
            logger.debug('System capacity sufficient for predicted load', { predictedRps, currentScale });
        }
    } catch (error) {
        logger.error('Pre-scaling orchestration failed', { error: error.message });
    }
}

module.exports = { triggerPreScaling };
