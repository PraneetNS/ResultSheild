/**
 * Student Authentication Middleware — Phase 9
 *
 * Validates a JWT Bearer token on protected routes.
 * Token payload: { sub: rollNumber, role: "student" | "admin", iat, exp }
 *
 * Routes marked with requireAuth() will return 401 if the token is missing/invalid.
 * Admin-only routes additionally require role === 'admin'.
 *
 * Token is issued by  POST /api/v1/auth/login  (username = rollNumber, password = DOB-DDMMYYYY).
 */

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.AUTH_JWT_SECRET || 'resultshield-student-auth-secret-2024';
const JWT_EXPIRY = process.env.AUTH_JWT_EXPIRY || '2h';

/**
 * Issue a short-lived JWT for a given student roll number.
 * @param {string} rollNumber
 * @param {string} role  'student' | 'admin'
 * @returns {string} signed JWT
 */
function issueToken(rollNumber, role = 'student') {
    return jwt.sign(
        { sub: rollNumber, role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY, issuer: 'resultshield', audience: 'resultshield-portal' }
    );
}

/**
 * Express middleware — verifies JWT.
 * Attaches decoded payload to req.student.
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid Authorization header. Use: Bearer <token>',
            correlationId: req.correlationId
        });
    }

    const token = authHeader.slice(7);

    try {
        const payload = jwt.verify(token, JWT_SECRET, {
            issuer: 'resultshield',
            audience: 'resultshield-portal'
        });

        req.student = payload;
        next();

    } catch (err) {
        logger.warn('Auth token invalid', { error: err.message, correlationId: req.correlationId });

        const statusCode = err.name === 'TokenExpiredError' ? 401 : 403;
        return res.status(statusCode).json({
            error: err.name === 'TokenExpiredError' ? 'TokenExpired' : 'Forbidden',
            message: err.name === 'TokenExpiredError'
                ? 'Your session has expired. Please log in again.'
                : 'Invalid authentication token.',
            correlationId: req.correlationId
        });
    }
}

/**
 * Express middleware — requires admin role.
 * Must be used AFTER requireAuth.
 */
function requireAdmin(req, res, next) {
    if (!req.student || req.student.role !== 'admin') {
        return res.status(403).json({
            error: 'Forbidden',
            message: 'Admin access required.',
            correlationId: req.correlationId
        });
    }
    next();
}

/**
 * Optional auth — attach student info if token present, but don't block.
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            req.student = jwt.verify(authHeader.slice(7), JWT_SECRET, {
                issuer: 'resultshield',
                audience: 'resultshield-portal'
            });
        } catch (_) { /* ignore */ }
    }
    next();
}

module.exports = { issueToken, requireAuth, requireAdmin, optionalAuth };
