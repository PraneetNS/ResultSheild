const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Correlation ID Header name
const CORRELATION_ID_HEADER = 'X-Correlation-ID';

/**
 * Correlation ID Middleware
 * Ensures every request has a unique correlation ID for cross-service tracking.
 */
const correlationIdMiddleware = (req, res, next) => {
    const correlationId = req.headers[CORRELATION_ID_HEADER.toLowerCase()] || uuidv4();

    // Attach to request object
    req.correlationId = correlationId;
    req.requestId = correlationId; // Sync with existing requestId usage

    // Ensure response has it too
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
};

/**
 * Log Sampling Logic
 * Used to reduce log volume under heavy load (e.g. Phase 8 predictions can trigger this)
 */
const logSamplingMiddleware = (req, res, next) => {
    // Basic sampling: log only 10% of info logs if load is very high
    // (In a real system, this would be dynamic based on RPS/Predictor)
    const isSampled = Math.random() < 0.1;

    req.isLogSampled = isSampled;

    next();
};

/**
 * Helper to log only if sampled or if it's an error
 */
const sampledLogger = (level, message, meta) => {
    if (level === 'error' || level === 'warn') {
        logger[level](message, meta);
    } else {
        // Only log info if 'debug' mode or sampled or critical logic
        if (process.env.LOG_LEVEL === 'debug' || meta.forceLog) {
            logger.info(message, meta);
        }
    }
};

module.exports = {
    correlationIdMiddleware,
    logSamplingMiddleware,
    CORRELATION_ID_HEADER
};
