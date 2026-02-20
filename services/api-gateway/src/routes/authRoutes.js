/**
 * Authentication Routes — Phase 9
 *
 * POST /api/v1/auth/login   → issue JWT (roll number + simulated credential check)
 * POST /api/v1/auth/refresh → refresh a still-valid token
 * GET  /api/v1/auth/me      → return decoded token info
 *
 * In a real deployment, the password would be verified against a hashed credential
 * stored in the database (e.g., DOB, last-4 of student ID).
 * For this demo, any non-empty password is accepted and a JWT is issued.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { issueToken, requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Strict rate limit on login endpoint (prevent brute-force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,                   // 10 attempts per 15 min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

/**
 * POST /api/v1/auth/login
 * Body: { rollNumber: "2024CS0001", password: "any-non-empty-string" }
 * Returns: { token, expiresIn, rollNumber, role }
 */
router.post('/login', loginLimiter, (req, res) => {
    const { rollNumber, password } = req.body;

    if (!rollNumber || typeof rollNumber !== 'string') {
        return res.status(400).json({ error: 'rollNumber is required' });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'password is required' });
    }

    // Normalize roll number
    const normalized = rollNumber.trim().toUpperCase();

    // Determine role: 'admin' if roll number starts with ADMIN, else 'student'
    const role = normalized.startsWith('ADMIN') ? 'admin' : 'student';

    const token = issueToken(normalized, role);

    logger.info('Auth: token issued', {
        rollNumber: normalized,
        role,
        correlationId: req.correlationId
    });

    return res.json({
        token,
        tokenType: 'Bearer',
        expiresIn: '2h',
        rollNumber: normalized,
        role
    });
});

/**
 * POST /api/v1/auth/refresh
 * Header: Authorization: Bearer <token>
 * Returns a new token if the current one is still valid
 */
router.post('/refresh', requireAuth, (req, res) => {
    const newToken = issueToken(req.student.sub, req.student.role);

    logger.info('Auth: token refreshed', {
        rollNumber: req.student.sub,
        correlationId: req.correlationId
    });

    return res.json({
        token: newToken,
        tokenType: 'Bearer',
        expiresIn: '2h',
        rollNumber: req.student.sub,
        role: req.student.role
    });
});

/**
 * GET /api/v1/auth/me
 * Returns decoded token payload for the current user
 */
router.get('/me', requireAuth, (req, res) => {
    return res.json({
        rollNumber: req.student.sub,
        role: req.student.role,
        issuedAt: new Date(req.student.iat * 1000).toISOString(),
        expiresAt: new Date(req.student.exp * 1000).toISOString()
    });
});

module.exports = router;
