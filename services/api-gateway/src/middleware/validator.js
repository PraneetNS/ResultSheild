const { param, body, validationResult } = require('express-validator');

/**
 * Common validation rules and error handling middleware
 */

const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            error: 'Validation Error',
            errors: errors.array(),
            correlationId: req.correlationId
        });
    }
    next();
};

const resultQueryValidator = [
    param('rollNumber')
        .isString()
        .trim()
        .isLength({ min: 5, max: 20 })
        .matches(/^[A-Z0-9]+$/i)
        .withMessage('Roll number must be alphanumeric (5-20 chars)'),
    validate
];

const batchQueryValidator = [
    body('rollNumbers')
        .isArray({ min: 1, max: 100 })
        .withMessage('rollNumbers must be an array (1-100 entries)'),
    body('rollNumbers.*')
        .isString()
        .trim()
        .notEmpty(),
    validate
];

module.exports = {
    resultQueryValidator,
    batchQueryValidator
};
