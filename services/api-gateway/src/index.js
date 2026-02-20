const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./utils/logger');
const rateLimiter = require('./middleware/rateLimiter');
const adaptiveLimiter = require('./middleware/adaptiveLimiter');
const circuitBreaker = require('./middleware/circuitBreaker');
const waitingRoom = require('./middleware/waitingRoom');
const routes = require('./routes');
const compression = require('compression');
const { initializeRedis } = require('./utils/redis');
const { register, metrics } = require('./utils/metrics');
const { startAdaptiveMonitoring } = require('./services/adaptiveLimiterService');
const { correlationIdMiddleware, logSamplingMiddleware } = require('./middleware/hardening');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Middleware Setup
// ============================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// Performance
app.use(compression());

// Production Hardening: Correlation ID & Log Sampling
app.use(correlationIdMiddleware);
app.use(logSamplingMiddleware);

// CORS configuration (Simplified for local testing)
app.use(cors());

// Body parsing (Limited)
app.use(express.json({ limit: '1mb' })); // Reduced from 10mb for production hardening
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Prometheus HTTP Instrumentation Middleware ───────────────────────────────
// Tracks: http_requests_total, http_request_duration_seconds, http_errors_total
// Does NOT modify any business logic.
app.use((req, res, next) => {
  // Skip /metrics endpoint itself to avoid self-instrumentation noise
  if (req.path === '/metrics') return next();

  const start = process.hrtime.bigint();
  metrics.activeConnections.labels({ service: 'api-gateway' }).inc();

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationSec = Number(durationNs) / 1e9;

    const route = req.route ? req.route.path : req.path;
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
      service: 'api-gateway'
    };

    metrics.httpRequestsTotal.labels(labels).inc();
    metrics.httpRequestDurationSeconds.labels(labels).observe(durationSec);

    if (res.statusCode >= 400) {
      metrics.httpErrorsTotal.labels(labels).inc();
    }

    metrics.activeConnections.labels({ service: 'api-gateway' }).dec();
  });

  next();
});

// Request logging with Correlation ID
app.use((req, res, next) => {
  // Use correlationId instead of fresh uuid if available (thanks to middleware)
  const requestId = req.correlationId;

  logger.info('Incoming request', {
    correlationId: requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  // Track active connections for visibility
  metrics.activeConnections.labels({ service: 'api-gateway' }).inc();
  res.on('finish', () => {
    metrics.activeConnections.labels({ service: 'api-gateway' }).dec();
  });

  next();
});

// Adaptive Rate Limiting (Phase 7)
app.use(adaptiveLimiter);

// Rate limiting
app.use(rateLimiter);

// Waiting room (Phase 5)
app.use(waitingRoom);

// Circuit breaker
app.use(circuitBreaker);

// ============================================
// Routes
// ============================================

app.use('/api/v1', routes);

// ─── Prometheus /metrics endpoint ────────────────────────────────────────────
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
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    instance: process.env.INSTANCE_ID || 'unknown'
  });
});

// Readiness check
app.get('/ready', async (req, res) => {
  try {
    // Check Redis connection
    const redis = require('./utils/redis').getRedisClient();
    await redis.ping();

    res.json({
      status: 'ready',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Readiness check failed', { error: error.message });
    res.status(503).json({
      status: 'not ready',
      error: error.message
    });
  }
});

// ============================================
// Error Handling
// ============================================

// 404 handler
app.use((req, res) => {
  logger.warn('Route not found', {
    requestId: req.requestId,
    path: req.path,
    method: req.method
  });

  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    requestId: req.requestId
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    requestId: req.requestId,
    error: err.message,
    stack: err.stack
  });

  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message,
    requestId: req.requestId
  });
});

// ============================================
// Server Startup
// ============================================

async function startServer() {
  try {
    // Initialize Redis connection
    await initializeRedis();
    logger.info('Redis connection established');

    // Start Adaptive Monitoring (Phase 7)
    if (process.env.ENABLE_ADAPTIVE_LIMITING === 'true') {
      startAdaptiveMonitoring();
    }

    // Start Express server
    app.listen(PORT, () => {
      logger.info(`API Gateway started`, {
        port: PORT,
        environment: process.env.NODE_ENV,
        instance: process.env.INSTANCE_ID || 'unknown'
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);

  const redis = require('./utils/redis').getRedisClient();
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.error('Error closing Redis connection', { error: err.message });
  }

  // Allow some time for existing requests to finish
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 1000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the server
startServer();

module.exports = app;
