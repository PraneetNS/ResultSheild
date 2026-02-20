/**
 * Adaptive Rate Limiting Service (Phase 7)
 *
 * Monitors system health (Latency, Queue, Errors) and adjusts
 * global rate limit multipliers.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getRedisClient } = require('../utils/redis');
const { metrics } = require('../utils/metrics');

// Configuration
const SERVICES = {
    WAITING_ROOM: process.env.WAITING_ROOM_URL || 'http://waiting-room:8001',
    RESULT_SERVICE: process.env.RESULT_SERVICE_URL || 'http://result-service-1:8000', // We can probe one or multiple
    API_GATEWAY_SELF: 'http://localhost:3000'
};

const UPDATE_INTERVAL = 10000; // 10 seconds
const STABILITY_WINDOW = 300000; // 5 minutes to restore limits

// Thresholds
const THRESHOLDS = {
    QUEUE_LENGTH: 1000,
    P95_LATENCY: 0.5, // 500ms
    ERROR_RATE: 0.05, // 5%
    DB_LATENCY: 0.2, // 200ms
    REDIS_LATENCY: 0.05 // 50ms
};

// State
let lastHealedAt = Date.now();
let currentMultiplier = 1.0;

/**
 * Parses Prometheus metrics text format to get specific gauge/histogram values
 */
function parseMetric(text, name, labels = {}) {
    // Very basic parser for Prometheus text format
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.startsWith(name)) {
            // Check labels if provided
            let match = true;
            for (const [k, v] of Object.entries(labels)) {
                if (!line.includes(`${k}="${v}"`)) {
                    match = false;
                    break;
                }
            }
            if (match) {
                const parts = line.split(' ');
                return parseFloat(parts[parts.length - 1]);
            }
        }
    }
    return null;
}

/**
 * Poll metrics from all services
 */
async function gatherSystemMetrics() {
    const systemState = {
        queueLength: 0,
        p95Latency: 0,
        errorRate: 0,
        dbLatency: 0,
        redisLatency: 0
    };

    try {
        // 1. Get Waiting Room metrics
        const wrMetrics = await axios.get(`${SERVICES.WAITING_ROOM}/metrics`, { timeout: 2000 });
        systemState.queueLength = parseMetric(wrMetrics.data, 'queue_length') || 0;

        // 2. Get Result Service metrics (using instance 1 as representative or aggregate if needed)
        // For p95 latency and DB latency
        const rsMetrics = await axios.get(`${SERVICES.RESULT_SERVICE}/metrics`, { timeout: 2000 });

        // Find p95 latency for results endpoint
        // In RS, it's http_request_duration_seconds_bucket and we'd need quantile calculation
        // As a shortcut for this internal agent, we'll look for the sum/count or just a processed metric if available
        // Since we don't have a prometheus query engine here, we'll estimate or use the raw counters to calc rate

        // Actually, let's look for db_query_duration_seconds if it's exposed as a summary/gauge or just use the last bucket
        systemState.dbLatency = parseMetric(rsMetrics.data, 'db_query_duration_seconds_sum') /
            Math.max(1, parseMetric(rsMetrics.data, 'db_query_duration_seconds_count')) || 0;

        // 3. Local (API Gateway) metrics
        const localMetrics = await require('../utils/metrics').register.metrics();
        systemState.redisLatency = parseMetric(localMetrics, 'redis_latency_seconds_sum') /
            Math.max(1, parseMetric(localMetrics, 'redis_latency_seconds_count')) || 0;

        // Error rate
        const totalReq = parseMetric(localMetrics, 'http_requests_total_sum') || 1;
        const totalErr = parseMetric(localMetrics, 'http_errors_total_sum') || 0;
        systemState.errorRate = totalErr / Math.max(1, totalReq);

    } catch (error) {
        logger.warn('Failed to gather some system metrics', { error: error.message });
    }

    return systemState;
}

/**
 * Core Adaptive Logic
 */
async function adjustLimits() {
    const state = await gatherSystemMetrics();
    const redis = getRedisClient();

    let multiplier = 1.0;
    let reason = 'stable';
    let direction = 'none';

    // Rule 1: Queue Length
    if (state.queueLength > THRESHOLDS.QUEUE_LENGTH) {
        multiplier = Math.min(multiplier, 0.5);
        reason = 'high_queue';
        direction = 'decrease';
    }

    // Rule 2: p95 Latency (estimated via avg here for simplicity without PromQL)
    if (state.p95Latency > THRESHOLDS.P95_LATENCY || state.dbLatency > THRESHOLDS.DB_LATENCY) {
        multiplier = Math.min(multiplier, 0.7);
        reason = 'high_latency';
        direction = 'decrease';
    }

    // Rule 3: Error Rate
    if (state.errorRate > THRESHOLDS.ERROR_RATE) {
        multiplier = Math.min(multiplier, 0.4);
        reason = 'high_errors';
        direction = 'decrease';
    }

    // Rule 4: System Stable -> Gradual recovery
    if (direction === 'none') {
        const timeSinceHeal = Date.now() - lastHealedAt;
        if (timeSinceHeal > STABILITY_WINDOW && currentMultiplier < 1.0) {
            multiplier = Math.min(1.0, currentMultiplier + 0.1);
            reason = 'recovery';
            direction = 'increase';
            lastHealedAt = Date.now(); // Reset window for next bump
        } else {
            multiplier = currentMultiplier;
        }
    } else {
        lastHealedAt = Date.now(); // Reset stability timer
    }

    // Update state if changed
    if (multiplier !== currentMultiplier) {
        logger.info('Adaptive rate limit adjustment', {
            oldMultiplier: currentMultiplier,
            newMultiplier: multiplier,
            reason,
            state
        });

        currentMultiplier = multiplier;
        await redis.set('adaptive:multiplier', multiplier.toString());

        // Update metrics
        metrics.adaptiveLimitChangesTotal.labels({ service: 'api-gateway', reason, direction }).inc();
        metrics.currentAdaptiveRateLimit.labels({ service: 'api-gateway' }).set(multiplier * 100);
    }
}

/**
 * Start the monitoring loop
 */
function startAdaptiveMonitoring() {
    if (process.env.ENABLE_ADAPTIVE_LIMITING !== 'true') {
        logger.info('Adaptive rate limiting is disabled');
        return;
    }

    logger.info('Starting adaptive rate limit monitoring');
    setInterval(adjustLimits, UPDATE_INTERVAL);
}

module.exports = {
    startAdaptiveMonitoring,
    getCurrentMultiplier: () => currentMultiplier
};
