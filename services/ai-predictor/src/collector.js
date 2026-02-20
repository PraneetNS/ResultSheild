const axios = require('axios');
const logger = require('./logger');
const config = require('./config');

/**
 * Metric Collector (Phase 8)
 * 
 * Fetches real-time telemetry from Prometheus or directly from services.
 */

async function fetchMetrics() {
    try {
        // We'll fetch from Prometheus as it aggregates all instances
        // Query: sum(rate(http_requests_total[1m]))
        const rpsResponse = await axios.get(`${config.PROMETHEUS_URL}/api/v1/query`, {
            params: {
                query: 'sum(rate(http_requests_total[1m]))'
            },
            timeout: 5000
        });

        const queueResponse = await axios.get(`${config.PROMETHEUS_URL}/api/v1/query`, {
            params: {
                query: 'max(queue_length)'
            },
            timeout: 5000
        });

        const errorResponse = await axios.get(`${config.PROMETHEUS_URL}/api/v1/query`, {
            params: {
                query: 'sum(rate(http_errors_total[1m])) / sum(rate(http_requests_total[1m]))'
            },
            timeout: 5000
        });

        const rps = parseFloat(rpsResponse.data.data.result[0]?.value[1] || 0);
        const queue = parseFloat(queueResponse.data.data.result[0]?.value[1] || 0);
        const errorRate = parseFloat(errorResponse.data.data.result[0]?.value[1] || 0);

        return {
            timestamp: Date.now(),
            requests_per_second: rps,
            queue_length: queue,
            error_rate: errorRate
        };
    } catch (error) {
        logger.error('Failed to fetch metrics from Prometheus', { error: error.message });

        // Fallback: Try to poll API Gateway directly for current RPS if Prometheus is down
        try {
            logger.info('Falling back to direct API Gateway poll');
            const gatewayMetrics = await axios.get(`${config.API_GATEWAY_URL}/metrics`, { timeout: 2000 });
            // Very simple parser for local instance
            const match = gatewayMetrics.data.match(/http_requests_total.* (\d+)/);
            return {
                timestamp: Date.now(),
                requests_per_second: match ? parseFloat(match[1]) / 60 : 0, // Very rough estimate
                queue_length: 0,
                error_rate: 0
            };
        } catch (fallbackError) {
            logger.error('Fallback poll failed', { error: fallbackError.message });
            return null;
        }
    }
}

module.exports = { fetchMetrics };
