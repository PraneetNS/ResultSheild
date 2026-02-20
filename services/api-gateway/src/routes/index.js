const express = require('express');
const logger = require('../utils/logger');
const { cache } = require('../utils/redis');
const createRequester = require('../utils/requester');
const { resultQueryValidator, batchQueryValidator } = require('../middleware/validator');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const authRoutes = require('./authRoutes');

const router = express.Router();

// Mount auth sub-router
router.use('/auth', authRoutes);

const RESULT_SERVICE_URL = process.env.RESULT_SERVICE_URL || 'http://localhost:8000';
const WAITING_ROOM_URL = process.env.WAITING_ROOM_URL || 'http://localhost:8001';

/**
 * GET /api/v1/results/:rollNumber
 * Public: returns result for any roll number.
 * Authenticated: additionally enforces that a student can only fetch their OWN result
 *   (unless they are an admin).
 */
router.get('/results/:rollNumber', optionalAuth, resultQueryValidator, async (req, res) => {
    const { rollNumber } = req.params;
    const correlationId = req.correlationId;
    const requester = createRequester(req);

    // If authenticated as a student, enforce self-lookup only
    if (req.student && req.student.role === 'student' &&
        req.student.sub.toUpperCase() !== rollNumber.toUpperCase()) {
        return res.status(403).json({
            error: 'Forbidden',
            message: 'You can only look up your own results. Provide an admin token to access other records.',
            correlationId
        });
    }

    try {
        const cacheKey = `result:${rollNumber}`;
        const cachedResult = await cache.get(cacheKey);

        if (cachedResult) {
            return res.json({
                ...cachedResult,
                metadata: { ...cachedResult.metadata, cached: true, correlationId }
            });
        }

        // Fetch with circuit breaker and standard requester
        const result = await req.executeWithCircuitBreaker(
            'resultService',
            async () => {
                const response = await requester.get(`${RESULT_SERVICE_URL}/api/results/${rollNumber}`);
                return response.data;
            },
            async () => {
                logger.warn('Circuit breaker fallback', { correlationId, rollNumber });
                return {
                    rollNumber,
                    message: 'Service temporarily unavailable.',
                    degraded: true
                };
            }
        );

        if (!result.degraded) {
            await cache.set(cacheKey, result, 3600);
        }

        res.json({
            ...result,
            metadata: { ...result.metadata, cached: false, correlationId }
        });

    } catch (error) {
        logger.error('Error fetching result', { correlationId, error: error.message });
        res.status(error.response?.status || 500).json({
            error: 'Request failed',
            correlationId
        });
    }
});

/**
 * POST /api/v1/results/batch
 */
router.post('/results/batch', batchQueryValidator, async (req, res) => {
    const { rollNumbers } = req.body;
    const correlationId = req.correlationId;
    const requester = createRequester(req);

    if (!Array.isArray(rollNumbers) || rollNumbers.length > 100) {
        return res.status(400).json({ error: 'Invalid batch size (max 100)', correlationId });
    }

    try {
        const results = await Promise.all(
            rollNumbers.map(async (rollNumber) => {
                try {
                    const cacheKey = `result:${rollNumber}`;
                    const cached = await cache.get(cacheKey);
                    if (cached) return { ...cached, cached: true };

                    const res = await requester.get(`${RESULT_SERVICE_URL}/api/results/${rollNumber}`);
                    await cache.set(cacheKey, res.data, 3600);
                    return { ...res.data, cached: false };
                } catch (e) {
                    return { rollNumber, success: false, error: e.message };
                }
            })
        );
        res.json({ results, correlationId });
    } catch (error) {
        res.status(500).json({ error: 'Batch operation failed', correlationId });
    }
});

router.get('/queue/join', async (req, res) => {
    const correlationId = req.correlationId;
    const userId = req.headers['x-user-id'] || req.ip;
    const requester = createRequester(req);

    try {
        const response = await requester.post(`${WAITING_ROOM_URL}/api/queue/join`, { userId });
        res.json({ ...response.data, correlationId });
    } catch (error) {
        res.status(500).json({ error: 'Queue join failed', correlationId });
    }
});

router.get('/stats', async (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        circuitBreakers: {
            resultService: req.circuitBreakers.resultService.getState()
        },
        correlationId: req.correlationId
    });
});

module.exports = router;
