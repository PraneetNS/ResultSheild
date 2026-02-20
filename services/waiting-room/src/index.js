const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./utils/logger');
const queueRoutes = require('./routes/queueRoutes');
const { initializeRedis } = require('./services/queueRepository');
const { register, metrics } = require('./utils/metrics');
const { attachWebSocketServer, getSubscriberCount } = require('./utils/websocketServer');

const app = express();
const PORT = process.env.PORT || 8001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// ─── Prometheus HTTP Instrumentation Middleware ───────────────────────────────
app.use((req, res, next) => {
    if (req.path === '/metrics') return next();

    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
        const route = req.route ? req.route.path : req.path;
        const labels = {
            method: req.method,
            route,
            status_code: String(res.statusCode),
            service: 'waiting-room'
        };

        metrics.httpRequestsTotal.labels(labels).inc();
        metrics.httpRequestDurationSeconds.labels(labels).observe(durationSec);

        if (res.statusCode >= 400) {
            metrics.httpErrorsTotal.labels(labels).inc();
        }
    });

    next();
});

// Request logging with Correlation ID
app.use((req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || `wr-${Date.now()}`;
    req.correlationId = correlationId;
    req.requestId = correlationId; // Legacy support

    logger.info('Incoming request', {
        correlationId,
        method: req.method,
        path: req.path,
        ip: req.ip
    });

    next();
});

// Routes
app.use('/queue', queueRoutes);

// ─── Prometheus /metrics endpoint ────────────────────────────────────────────
// Always returns Prometheus text format (Prometheus scrapes this directly)
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'waiting-room',
        timestamp: new Date().toISOString(),
        websocketSubscribers: getSubscriberCount()
    });
});

// WebSocket stats endpoint
app.get('/ws/stats', (req, res) => {
    res.json({
        activeWebSocketSubscribers: getSubscriberCount(),
        pushIntervalMs: parseInt(process.env.WS_PUSH_INTERVAL_MS) || 3000,
        path: 'ws://HOST:8001/ws'
    });
});

// Error handling
app.use((err, req, res, next) => {
    logger.error('Unhandled error', {
        requestId: req.requestId,
        error: err.message,
        stack: err.stack
    });

    res.status(500).json({
        error: 'Internal server error',
        requestId: req.requestId
    });
});

// Graceful shutdown
const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);

    // Close redis
    try {
        const { getRedisClient } = require('./services/queueRepository');
        const redis = getRedisClient();
        await redis.quit();
        logger.info('Redis connection closed');
    } catch (err) { }

    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Initialize and start
async function start() {
    try {
        // Initialize Redis connection
        await initializeRedis();
        logger.info('Redis connection established');

        // Create HTTP server so WebSocket and Express share the same port
        const server = http.createServer(app);

        // Attach WebSocket server
        attachWebSocketServer(server);

        // Start listening
        server.listen(PORT, () => {
            logger.info(`Waiting Room Service listening on port ${PORT} (HTTP + WS)`);
        });

        return server;
    } catch (error) {
        logger.error('Failed to start server', { error: error.message });
        process.exit(1);
    }
}

start();

module.exports = app;
