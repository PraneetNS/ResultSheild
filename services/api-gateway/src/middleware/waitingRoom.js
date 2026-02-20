const createRequester = require('../utils/requester');
const logger = require('../utils/logger');

const WAITING_ROOM_URL = process.env.WAITING_ROOM_URL || 'http://waiting-room:8001';
const WAITING_ROOM_ENABLED = process.env.WAITING_ROOM_ENABLED === 'true';

/**
 * Waiting Room Middleware (Hardened)
 */
const waitingRoomMiddleware = async (req, res, next) => {
    if (!WAITING_ROOM_ENABLED || req.path === '/health' || req.path === '/ready' || req.path === '/metrics') {
        return next();
    }

    const userId = req.headers['x-user-id'] || req.ip;
    const correlationId = req.correlationId;
    const accessToken = req.headers['x-waiting-room-token'];

    // Use standardized requester with retries and timeouts
    const requester = createRequester(req);

    try {
        const response = await requester.post(`${WAITING_ROOM_URL}/queue/access`, {
            userId,
            token: accessToken
        }, {
            timeout: 2000 // Fast failover for waiting room
        });

        const { allowed, token, queuePosition, estimatedWaitTime, retryAfter, message } = response.data;

        if (allowed) {
            if (token) {
                req.waitingRoomToken = token;
                res.setHeader('X-Waiting-Room-Token', token);
            }
            return next();
        }

        logger.info('User redirected to waiting room', {
            userId,
            correlationId,
            queuePosition
        });

        return res.status(503).json({
            status: 'waiting',
            message: message || 'You are in the virtual waiting room.',
            queuePosition,
            estimatedWaitTime,
            retryAfter: retryAfter || 30,
            correlationId,
            waiting_room: true
        });

    } catch (error) {
        // Fallback: Degraded mode (fail-open)
        logger.error('Waiting room service error - entering degraded mode', {
            correlationId,
            error: error.message
        });
        return next();
    }
};

module.exports = waitingRoomMiddleware;
