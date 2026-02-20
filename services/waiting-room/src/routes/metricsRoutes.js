const express = require('express');
const router = express.Router();
const queueService = require('../services/queueService');
const { register } = require('../utils/metrics');

/**
 * Get internal queue metrics
 * GET /metrics
 */
router.get('/', async (req, res, next) => {
    try {
        const queueMetrics = await queueService.getMetrics();

        // Check if client wants Prometheus metrics or JSON
        if (req.headers.accept && req.headers.accept.includes('text/plain')) {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        } else {
            res.json(queueMetrics);
        }
    } catch (error) {
        next(error);
    }
});

module.exports = router;
