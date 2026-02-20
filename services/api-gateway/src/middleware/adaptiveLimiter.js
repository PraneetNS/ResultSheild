/**
 * Adaptive Rate Limiting Middleware (Phase 7)
 *
 * 1. Calculates/Retrieves IP risk score
 * 2. Applies penalties (delays, severe limits)
 * 3. Integrates with global adaptive multiplier
 */

const logger = require('../utils/logger');
const { getRedisClient } = require('../utils/redis');
const { metrics } = require('../utils/metrics');
const { getCurrentMultiplier } = require('../services/adaptiveLimiterService');

// Configuration
const RISK_THRESHOLD_LOW = 30;
const RISK_THRESHOLD_HIGH = 70;
const RISK_THRESHOLD_BLOCK = 95;

const PENALTY_DELAY_LOW = 200; // ms
const PENALTY_DELAY_HIGH = 500; // ms

/**
 * Enhanced IP Risk Scoring
 */
async function getAndIncrementRiskScore(req) {
    const ip = req.ip;
    const redis = getRedisClient();
    const riskKey = `risk:score:${ip}`;
    const patternKey = `risk:pattern:${ip}`;

    // Default increment for just showing up
    let increment = 0;

    // 1. Header Analysis (Quick check for missing/common bot headers)
    const ua = req.get('user-agent') || '';
    if (!ua || ua.includes('curl') || ua.includes('Postman')) {
        increment += 5;
    }

    // 2. Burst Pattern Detection
    // Count requests in last 5 seconds
    const burstCount = await redis.incrEx(patternKey, 5);
    if (burstCount > 50) {
        increment += 20; // Aggressive burst
    } else if (burstCount > 20) {
        increment += 5;
    }

    // Update score in Redis
    if (increment > 0) {
        await redis.incrBy(riskKey, increment);
        await redis.expire(riskKey, 3600); // 1 hour window
    }

    const currentScore = parseInt(await redis.get(riskKey)) || 0;

    // Decay risk score gradually if it's high? 
    // For now, we rely on the 1 hour TTL for the whole key.

    return currentScore;
}

/**
 * Middleware Implementation
 */
async function adaptiveLimiterMiddleware(req, res, next) {
    if (process.env.ENABLE_ADAPTIVE_LIMITING !== 'true') {
        return next();
    }

    const ip = req.ip;

    try {
        // 1. Get current IP risk score
        const riskScore = await getAndIncrementRiskScore(req);

        // 2. Get global system multiplier
        const systemMultiplier = getCurrentMultiplier();

        // 3. Apply Multiplier to the request object for the next RateLimiter middleware to use
        // We attach it so rateLimiter.js can pick it up
        req.adaptiveMultiplier = systemMultiplier;

        // 4. Handle Penalties based on Risk Score
        let delay = 0;

        if (riskScore >= RISK_THRESHOLD_BLOCK) {
            logger.warn('IP Blocked by Adaptive Limiter', { ip, riskScore });
            metrics.flaggedIpsTotal.labels({ service: 'api-gateway' }).set(1); // Increment gauge
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Access denied due to suspicious activity.',
                requestId: req.requestId
            });
        }

        if (riskScore >= RISK_THRESHOLD_HIGH) {
            // Severe limit + high delay
            req.adaptiveMultiplier *= 0.2;
            delay = PENALTY_DELAY_HIGH;
            metrics.artificialDelayAppliedTotal.labels({ service: 'api-gateway' }).inc();
        } else if (riskScore >= RISK_THRESHOLD_LOW) {
            // Moderate limit + low delay
            req.adaptiveMultiplier *= 0.5;
            delay = PENALTY_DELAY_LOW;
            metrics.artificialDelayAppliedTotal.labels({ service: 'api-gateway' }).inc();
        }

        // Apply artificial delay if needed
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Attach metrics for response headers or logging
        res.setHeader('X-Risk-Score', riskScore);
        res.setHeader('X-System-Health-Multiplier', systemMultiplier.toFixed(2));

        // 5. Hook into response finish to track failures
        res.on('finish', async () => {
            if (res.statusCode >= 400) {
                // Increment risk for failures (4xx, 5xx)
                const redis = getRedisClient();
                const riskKey = `risk:score:${ip}`;
                await redis.incrBy(riskKey, 2); // Small bump for errors
            }
        });

        next();
    } catch (error) {
        logger.error('Adaptive limiter middleware error', { error: error.message });
        next();
    }
}

module.exports = adaptiveLimiterMiddleware;
