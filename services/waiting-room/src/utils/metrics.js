/**
 * Prometheus Metrics - Waiting Room Service (Phase 6: Observability)
 *
 * Exposes all required metrics:
 *   HTTP Layer, Queue, System
 * Does NOT change any business logic.
 */

const client = require('prom-client');

// ─── Registry ────────────────────────────────────────────────────────────────
const register = new client.Registry();

client.collectDefaultMetrics({
    register,
    prefix: 'nodejs_',
    labels: { service: 'waiting-room' }
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

// ─── Queue Metrics ────────────────────────────────────────────────────────────

const queueLength = new client.Gauge({
    name: 'queue_length',
    help: 'Current number of users in the waiting queue',
    labelNames: ['service'],
    registers: [register]
});

const averageWaitTime = new client.Gauge({
    name: 'average_wait_time',
    help: 'Average wait time in seconds for users in the queue',
    labelNames: ['service'],
    registers: [register]
});

const activeSessions = new client.Gauge({
    name: 'active_sessions',
    help: 'Number of currently active user sessions',
    labelNames: ['service'],
    registers: [register]
});

// ─── Queue Event Counters (existing, kept for backward compat) ────────────────

const usersQueuedTotal = new client.Counter({
    name: 'waiting_room_users_queued_total',
    help: 'Total number of users who entered the waiting room',
    registers: [register]
});

const queueAccessGrantedTotal = new client.Counter({
    name: 'waiting_room_queue_access_granted_total',
    help: 'Total number of users granted access from the queue',
    registers: [register]
});

const immediateAccessGrantedTotal = new client.Counter({
    name: 'waiting_room_immediate_access_granted_total',
    help: 'Total number of users granted immediate access',
    registers: [register]
});

const degradedModeAccessTotal = new client.Counter({
    name: 'waiting_room_degraded_mode_access_total',
    help: 'Total number of users granted access due to system degradation',
    registers: [register]
});

const sessionsReleasedTotal = new client.Counter({
    name: 'waiting_room_sessions_released_total',
    help: 'Total number of sessions released',
    registers: [register]
});

const queueProcessedTotal = new client.Counter({
    name: 'waiting_room_queue_processed_total',
    help: 'Total number of users processed from queue',
    registers: [register]
});

// ─── System Metrics ───────────────────────────────────────────────────────────

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

// ─── System Metrics Collector ─────────────────────────────────────────────────

let _prevCpuUsage = process.cpuUsage();
let _prevTime = Date.now();

function collectSystemMetrics() {
    const mem = process.memoryUsage();
    memoryUsageBytes.labels({ service: 'waiting-room', type: 'rss' }).set(mem.rss);
    memoryUsageBytes.labels({ service: 'waiting-room', type: 'heap_used' }).set(mem.heapUsed);
    memoryUsageBytes.labels({ service: 'waiting-room', type: 'heap_total' }).set(mem.heapTotal);

    const currCpuUsage = process.cpuUsage();
    const currTime = Date.now();
    const elapsedMs = currTime - _prevTime;
    if (elapsedMs > 0) {
        const userDelta = (currCpuUsage.user - _prevCpuUsage.user) / 1000;
        const sysDelta = (currCpuUsage.system - _prevCpuUsage.system) / 1000;
        const cpuPercent = ((userDelta + sysDelta) / elapsedMs) * 100;
        cpuUsagePercent.labels({ service: 'waiting-room' }).set(Math.min(cpuPercent, 100));
    }
    _prevCpuUsage = currCpuUsage;
    _prevTime = currTime;
}

setInterval(collectSystemMetrics, 5000);
collectSystemMetrics();

// ─── Named metric map (for recordMetric compatibility) ────────────────────────

const _namedMetrics = {
    users_queued: usersQueuedTotal,
    queue_access_granted: queueAccessGrantedTotal,
    immediate_access_granted: immediateAccessGrantedTotal,
    degraded_mode_access: degradedModeAccessTotal,
    sessions_released: sessionsReleasedTotal,
    queue_processed: queueProcessedTotal
};

/**
 * Record a named event counter (backward-compatible with existing queueService calls)
 */
function recordMetric(name, value = 1) {
    if (_namedMetrics[name]) {
        _namedMetrics[name].inc(value);
    }
}

/**
 * Update live queue gauges (called from queueService after each state change)
 */
function updateQueueGauges(queueLen, avgWait, activeSess) {
    queueLength.labels({ service: 'waiting-room' }).set(queueLen || 0);
    averageWaitTime.labels({ service: 'waiting-room' }).set(avgWait || 0);
    activeSessions.labels({ service: 'waiting-room' }).set(activeSess || 0);
}

module.exports = {
    register,
    recordMetric,
    updateQueueGauges,
    metrics: {
        httpRequestsTotal,
        httpRequestDurationSeconds,
        httpErrorsTotal,
        queueLength,
        averageWaitTime,
        activeSessions,
        cpuUsagePercent,
        memoryUsageBytes
    }
};
