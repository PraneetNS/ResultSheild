const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'resultshield-waiting-room-secret-change-in-production';
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '5m';

/**
 * Generate access token for user (Hardened)
 */
function generateAccessToken(userId, metadata = {}) {
    try {
        const payload = {
            userId,
            jti: uuidv4(), // Token ID for replay protection tracking (if needed)
            type: 'waiting_room_access',
            iat: Math.floor(Date.now() / 1000),
            ...metadata
        };

        const token = jwt.sign(payload, JWT_SECRET, {
            expiresIn: TOKEN_EXPIRY,
            issuer: 'resultshield-waiting-room',
            algorithm: 'HS256' // Explicit algorithm
        });

        return token;
    } catch (error) {
        logger.error('Failed to generate access token', { userId, error: error.message });
        throw error;
    }
}

/**
 * Verify access token (Strict mode)
 */
function verifyAccessToken(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET, {
            issuer: 'resultshield-waiting-room',
            algorithms: ['HS256'], // Strict algorithm check
            complete: false
        });

        // Additional validation: Ensure token wasn't issued in the future 
        // and is within the allowed window
        const now = Math.floor(Date.now() / 1000);
        if (decoded.iat > now + 10) { // Allow 10s clock skew
            throw new Error('Token issued in future');
        }

        return decoded;
    } catch (error) {
        logger.warn('Token verification failed', { error: error.message });
        if (error.name === 'TokenExpiredError') throw new Error('Token expired');
        throw new Error('Invalid token');
    }
}

function getTokenExpirySeconds() {
    const expiry = TOKEN_EXPIRY;
    if (expiry.endsWith('m')) return parseInt(expiry) * 60;
    if (expiry.endsWith('s')) return parseInt(expiry);
    if (expiry.endsWith('h')) return parseInt(expiry) * 3600;
    return 300;
}

module.exports = {
    generateAccessToken,
    verifyAccessToken,
    getTokenExpirySeconds
};
