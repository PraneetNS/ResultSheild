/**
 * WebSocket Server — Real-Time Queue Position Updates
 *
 * Clients connect to  ws://waiting-room:8001/ws
 * After connecting they send: { "userId": "<id>" }
 * Server pushes updates every WS_PUSH_INTERVAL_MS with:
 *   {
 *     type:             "queue_update" | "access_granted" | "error"
 *     userId:           string
 *     status:           "queued" | "active" | "granted"
 *     queuePosition:    number | null
 *     totalInQueue:     number
 *     activeSessions:   number
 *     maxSessions:      number
 *     estimatedWaitSec: number
 *     timestamp:        ISO-string
 *   }
 */

const { WebSocketServer } = require('ws');
const logger = require('./logger');
const queueService = require('../services/queueService');

const WS_PUSH_INTERVAL_MS = parseInt(process.env.WS_PUSH_INTERVAL_MS) || 3000;

// Map of userId → { ws, intervalId }
const subscribers = new Map();

/**
 * Attach the WebSocket Server to an existing HTTP server created by Express.
 * @param {http.Server} httpServer
 */
function attachWebSocketServer(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    logger.info('WebSocket server initialised on path /ws');

    wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress;
        logger.info('WebSocket client connected', { clientIp });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                const userId = msg.userId;

                if (!userId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'userId required' }));
                    return;
                }

                // If already subscribed under a different userId, clean up first
                if (ws._userId && ws._userId !== userId) {
                    _unsubscribe(ws._userId);
                }

                ws._userId = userId;

                if (!subscribers.has(userId)) {
                    _subscribe(userId, ws);
                    logger.info('WebSocket subscription registered', { userId });
                }

                // Immediately push first update
                _pushUpdate(userId, ws);

            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            }
        });

        ws.on('close', () => {
            if (ws._userId) {
                _unsubscribe(ws._userId);
                logger.info('WebSocket client disconnected', { userId: ws._userId });
            }
        });

        ws.on('error', (err) => {
            logger.error('WebSocket error', { error: err.message, userId: ws._userId });
        });

        // Send connection ack
        ws.send(JSON.stringify({ type: 'connected', message: 'Connected to ResultShield Waiting Room. Send { "userId": "<id>" } to subscribe.' }));
    });

    return wss;
}

/**
 * Start a periodic push interval for a given userId.
 */
function _subscribe(userId, ws) {
    const intervalId = setInterval(async () => {
        if (!ws || ws.readyState !== 1 /* OPEN */) {
            _unsubscribe(userId);
            return;
        }
        await _pushUpdate(userId, ws);
    }, WS_PUSH_INTERVAL_MS);

    subscribers.set(userId, { ws, intervalId });
}

/**
 * Stop the periodic push for a userId.
 */
function _unsubscribe(userId) {
    const sub = subscribers.get(userId);
    if (sub) {
        clearInterval(sub.intervalId);
        subscribers.delete(userId);
    }
}

/**
 * Fetch current status and push one update frame to the client.
 */
async function _pushUpdate(userId, ws) {
    try {
        if (!ws || ws.readyState !== 1) return;

        const status = await queueService.checkQueueStatus(userId);
        const metrics = await queueService.getMetrics();

        let payload;

        if (status.status === 'granted' || status.status === 'active') {
            payload = {
                type: 'access_granted',
                userId,
                status: status.status,
                token: status.token,
                queuePosition: null,
                totalInQueue: metrics.queueLength,
                activeSessions: metrics.activeSessions,
                maxSessions: metrics.maxSessions,
                estimatedWaitSec: 0,
                timestamp: new Date().toISOString()
            };

            // Unsubscribe — no more updates needed once access is granted
            _unsubscribe(userId);

        } else {
            payload = {
                type: 'queue_update',
                userId,
                status: status.status || 'queued',
                queuePosition: status.queuePosition || null,
                totalInQueue: metrics.queueLength,
                activeSessions: metrics.activeSessions,
                maxSessions: metrics.maxSessions,
                estimatedWaitSec: status.estimatedWaitTime || 0,
                message: status.message || '',
                timestamp: new Date().toISOString()
            };
        }

        ws.send(JSON.stringify(payload));

    } catch (err) {
        logger.error('WebSocket push update failed', { userId, error: err.message });
    }
}

/**
 * Broadcast a message to ALL connected subscribers.
 * Used by the cleanup job to notify if someone gets promoted.
 */
function broadcastToAll(payload) {
    for (const [userId, { ws }] of subscribers.entries()) {
        if (ws && ws.readyState === 1) {
            _pushUpdate(userId, ws).catch(() => { });
        }
    }
}

/**
 * Return number of active WebSocket subscriptions.
 */
function getSubscriberCount() {
    return subscribers.size;
}

module.exports = {
    attachWebSocketServer,
    broadcastToAll,
    getSubscriberCount
};
