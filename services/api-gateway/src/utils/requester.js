const axios = require('axios');
const axiosRetry = require('axios-retry');
const { CORRELATION_ID_HEADER } = require('../middleware/hardening');

/**
 * Production-ready Requester (Phase: Hardening)
 * 
 * Includes:
 * - Default timeouts
 * - Automatic retry with exponential backoff
 * - Correlation ID propagation
 */

const createRequester = (req = null) => {
    const instance = axios.create({
        timeout: 5000, // 5s default timeout
        headers: {
            'Content-Type': 'application/json'
        }
    });

    // Configure Retry Logic
    axiosRetry(instance, {
        retries: 3,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => {
            // Retry on network errors or 5xx responses (except 503 if handled by waiting room)
            return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
                (error.response && error.response.status >= 500);
        }
    });

    // Request Interceptor: Inject Correlation ID
    instance.interceptors.request.use((config) => {
        if (req && req.correlationId) {
            config.headers[CORRELATION_ID_HEADER] = req.correlationId;
        }
        return config;
    });

    return instance;
};

module.exports = createRequester;
