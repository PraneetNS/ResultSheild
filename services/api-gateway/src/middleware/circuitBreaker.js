const logger = require('../utils/logger');
const { cache } = require('../utils/redis');
const { metrics } = require('../utils/metrics');

// State → numeric value for Prometheus gauge
const STATE_VALUES = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 };

/**
 * Circuit Breaker States
 */
const CircuitState = {
    CLOSED: 'CLOSED',     // Normal operation
    OPEN: 'OPEN',         // Failing, reject requests
    HALF_OPEN: 'HALF_OPEN' // Testing if service recovered
};

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
    constructor(options = {}) {
        this.threshold = options.threshold || 5; // failures before opening
        this.timeout = options.timeout || 30000; // ms before trying again
        this.monitoringPeriod = options.monitoringPeriod || 60000; // ms
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.nextAttempt = Date.now();
        this.successCount = 0;
    }

    /**
     * Execute function with circuit breaker protection
     */
    async execute(fn, fallback = null) {
        if (this.state === CircuitState.OPEN) {
            if (Date.now() < this.nextAttempt) {
                logger.warn('Circuit breaker is OPEN, using fallback');

                if (fallback) {
                    return await fallback();
                }

                throw new Error('Service temporarily unavailable');
            }

            // Try to recover
            this.state = CircuitState.HALF_OPEN;
            logger.info('Circuit breaker entering HALF_OPEN state');
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();

            if (fallback) {
                logger.warn('Circuit breaker executing fallback', {
                    error: error.message
                });
                return await fallback();
            }

            throw error;
        }
    }

    /**
     * Handle successful execution
     */
    onSuccess() {
        this.failures = 0;

        if (this.state === CircuitState.HALF_OPEN) {
            this.successCount++;

            if (this.successCount >= 3) {
                this.state = CircuitState.CLOSED;
                this.successCount = 0;
                // Update Prometheus metric
                metrics.circuitBreakerState
                    .labels({ service: 'api-gateway', target: this.name || 'unknown' })
                    .set(STATE_VALUES.CLOSED);
                logger.info('Circuit breaker CLOSED - service recovered');
            }
        }
    }

    /**
     * Handle failed execution
     */
    onFailure() {
        this.failures++;
        this.successCount = 0;

        if (this.failures >= this.threshold) {
            this.state = CircuitState.OPEN;
            this.nextAttempt = Date.now() + this.timeout;

            // Update Prometheus metric
            metrics.circuitBreakerState
                .labels({ service: 'api-gateway', target: this.name || 'unknown' })
                .set(STATE_VALUES.OPEN);

            logger.error('Circuit breaker OPEN - too many failures', {
                failures: this.failures,
                threshold: this.threshold,
                nextAttempt: new Date(this.nextAttempt).toISOString()
            });
        }
    }

    /**
     * Get current state
     */
    getState() {
        return {
            state: this.state,
            failures: this.failures,
            nextAttempt: new Date(this.nextAttempt).toISOString()
        };
    }

    /**
     * Reset circuit breaker
     */
    reset() {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();
        logger.info('Circuit breaker manually reset');
    }
}

// Create circuit breakers for different services
const circuitBreakers = {
    resultService: new CircuitBreaker({
        threshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,
        timeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT) * 1000 || 30000,
        name: 'result-service'
    }),
    waitingRoom: new CircuitBreaker({
        threshold: 5,
        timeout: 30000,
        name: 'waiting-room'
    })
};

// Initialize Prometheus gauges to CLOSED (0)
Object.entries(circuitBreakers).forEach(([, cb]) => {
    metrics.circuitBreakerState
        .labels({ service: 'api-gateway', target: cb.name || 'unknown' })
        .set(STATE_VALUES.CLOSED);
});

/**
 * Circuit breaker middleware
 */
function circuitBreakerMiddleware(req, res, next) {
    // Attach circuit breakers to request
    req.circuitBreakers = circuitBreakers;

    // Add helper method
    req.executeWithCircuitBreaker = async (serviceName, fn, fallback) => {
        const breaker = circuitBreakers[serviceName];

        if (!breaker) {
            logger.warn('Circuit breaker not found for service', { serviceName });
            return await fn();
        }

        return await breaker.execute(fn, fallback);
    };

    next();
}

module.exports = circuitBreakerMiddleware;
module.exports.CircuitBreaker = CircuitBreaker;
module.exports.circuitBreakers = circuitBreakers;
