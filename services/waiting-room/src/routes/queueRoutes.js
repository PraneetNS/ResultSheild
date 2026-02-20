const express = require('express');
const router = express.Router();
const queueService = require('../services/queueService');
const logger = require('../utils/logger');

/**
 * Request access to the system
 * POST /queue/access
 */
router.post('/access', async (req, res, next) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    try {
        const result = await queueService.checkAccess(userId);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * Check queue status for a user
 * GET /queue/status/:userId
 */
router.get('/status/:userId', async (req, res, next) => {
    const { userId } = req.params;

    try {
        const result = await queueService.checkQueueStatus(userId);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * Release a session (when user is done)
 * POST /queue/release
 */
router.post('/release', async (req, res, next) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    try {
        await queueService.releaseSession(userId);
        res.json({ success: true, message: 'Session released' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
