/**
 * Prometheus Metrics - API Gateway (Phase 6: Observability)
 *
 * Exposes all required metrics:
 *   HTTP Layer, Cache, System
 * Does NOT change any business logic.
 */

const client = require('prom-client');
const os = require('os');

// ─── Registry ────────────────────────────────────────────────────────────────
const register = new client.Registry();

// Collect default Node.js metrics (cpu, memory, event-loop, gc …)
client.collectDefaultMetrics({
    register,
    prefix: 'nodejs_',
    labels: { service: 'api-gateway' }
});

// ─── HTTP Layer ───────────────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code', 'service'],
    registers: [register]
});

const httpRequestDurationSeconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code', 'service'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register]
});

const httpErrorsTotal = new client.Counter({
    name: 'http_errors_total',
    help: 'Total number of HTTP errors (4xx + 5xx)',
    labelNames: ['method', 'route', 'status_code', 'service'],
    registers: [register]
});

// ─── Cache (Redis) ────────────────────────────────────────────────────────────

const redisCacheHitsTotal = new client.Counter({
    name: 'redis_cache_hits_total',
    help: 'Total number of Redis cache hits',
    labelNames: ['service', 'cache_type'],
    registers: [register]
});

const redisCacheMissesTotal = new client.Counter({
    name: 'redis_cache_misses_total',
    help: 'Total number of Redis cache misses',
    labelNames: ['service', 'cache_type'],
    registers: [register]
});

const redisLatencySeconds = new client.Histogram({
    name: 'redis_latency_seconds',
    help: 'Redis operation latency in seconds',
    labelNames: ['service', 'operation'],
    buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
    registers: [register]
});

// ─── System ───────────────────────────────────────────────────────────────────

const cpuUsagePercent = new client.Gauge({
    name: 'cpu_usage_percent',
    help: 'CPU usage percentage',
    labelNames: ['service'],
    registers: [register]
});

const memoryUsageBytes = new client.Gauge({
    name: 'memory_usage_bytes',
    help: 'Memory usage in bytes',
    labelNames: ['service', 'type'],
    registers: [register]
});

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

const rateLimitExceededTotal = new client.Counter({
    name: 'rate_limit_exceeded_total',
    help: 'Total number of rate limit exceeded events',
    labelNames: ['service', 'limit_type'],
    registers: [register]
});

// ─── Adaptive Rate Limiting (Phase 7) ──────────────────────────────────────────

const adaptiveLimitChangesTotal = new client.Counter({
    name: 'adaptive_limit_changes_total',
    help: 'Total number of times the adaptive rate limit was adjusted',
    labelNames: ['service', 'reason', 'direction'],
    registers: [register]
});

const flaggedIpsTotal = new client.Gauge({
    name: 'flagged_ips_total',
    help: 'Current number of IPs with high risk scores',
    labelNames: ['service'],
    registers: [register]
});

const artificialDelayAppliedTotal = new client.Counter({
    name: 'artificial_delay_applied_total',
    help: 'Total number of times artificial delays were applied to suspicious IPs',
    labelNames: ['service'],
    registers: [register]
});

const currentAdaptiveRateLimit = new client.Gauge({
    name: 'current_adaptive_rate_limit',
    help: 'Current dynamic rate limit multiplier (percentage of base limit)',
    labelNames: ['service'],
    registers: [register]
});

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

const circuitBreakerState = new client.Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
    labelNames: ['service', 'target'],
    registers: [register]
});

// ─── Active Connections ───────────────────────────────────────────────────────

const activeConnections = new client.Gauge({
    name: 'active_connections',
    help: 'Number of active HTTP connections',
    labelNames: ['service'],
    registers: [register]
});

// ─── System Metrics Collector ─────────────────────────────────────────────────

let _prevCpuUsage = process.cpuUsage();
let _prevTime = Date.now();

function collectSystemMetrics() {
    // Memory
    const mem = process.memoryUsage();
    memoryUsageBytes.labels({ service: 'api-gateway', type: 'rss' }).set(mem.rss);
    memoryUsageBytes.labels({ service: 'api-gateway', type: 'heap_used' }).set(mem.heapUsed);
    memoryUsageBytes.labels({ service: 'api-gateway', type: 'heap_total' }).set(mem.heapTotal);
    memoryUsageBytes.labels({ service: 'api-gateway', type: 'external' }).set(mem.external);

    // CPU
    const currCpuUsage = process.cpuUsage();
    const currTime = Date.now();
    const elapsedMs = currTime - _prevTime;
    if (elapsedMs > 0) {
        const userDelta = (currCpuUsage.user - _prevCpuUsage.user) / 1000; // µs → ms
        const sysDelta = (currCpuUsage.system - _prevCpuUsage.system) / 1000;
        const cpuPercent = ((userDelta + sysDelta) / elapsedMs) * 100;
        cpuUsagePercent.labels({ service: 'api-gateway' }).set(Math.min(cpuPercent, 100));
    }
    _prevCpuUsage = currCpuUsage;
    _prevTime = currTime;
}

// Collect every 5 seconds
setInterval(collectSystemMetrics, 5000);
collectSystemMetrics(); // Initial collection

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    register,
    metrics: {
        // HTTP
        httpRequestsTotal,
        httpRequestDurationSeconds,
        httpErrorsTotal,
        // Cache
        redisCacheHitsTotal,
        redisCacheMissesTotal,
        redisLatencySeconds,
        // System
        cpuUsagePercent,
        memoryUsageBytes,
        // Rate limiter
        rateLimitExceededTotal,
        // Adaptive
        adaptiveLimitChangesTotal,
        flaggedIpsTotal,
        artificialDelayAppliedTotal,
        currentAdaptiveRateLimit,
        // Circuit breaker
        circuitBreakerState,
        // Connections
        activeConnections
    }
};
