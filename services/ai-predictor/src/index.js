const express = require('express');
const logger = require('./logger');
const config = require('./config');
const { register, metrics } = require('./metrics');
const { fetchMetrics } = require('./collector');
const Forecaster = require('./forecaster');
const { triggerPreScaling } = require('./scaler');

/**
 * AI Traffic Predictor Service (Phase 8)
 * 
 * Orchestrates periodic polling, forecasting, and pre-scaling.
 */

const app = express();
const forecaster = new Forecaster(config.HISTORY_LIMIT);
let lastPrediction = null;

// HTTP endpoints
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', prediction_enabled: config.ENABLE_AI_PREDICTION });
});

app.get('/prediction', (req, res) => {
    res.json(lastPrediction || { status: 'waiting_for_data' });
});

/**
 * Main Prediction Loop
 */
async function predictionLoop() {
    if (!config.ENABLE_AI_PREDICTION) {
        logger.info('AI Traffic Prediction is disabled via config');
        return;
    }

    logger.info('Starting AI Prediction Loop...');

    // Run every interval
    setInterval(async () => {
        try {
            // 1. Collect actual metrics
            const currentData = await fetchMetrics();
            if (!currentData) return;

            const actualValue = currentData.requests_per_second;

            // 2. Track prediction error if we had a previous prediction for "now"
            // (Note: To be precise we need to store prediction timestamps, 
            // but for this lightweight version we'll just track current error vs last predicted level)
            if (lastPrediction && lastPrediction.predicted > 0) {
                const error = forecaster.calculateError(actualValue, lastPrediction.predicted);
                metrics.predictionError.set(error);
                logger.debug('Prediction Error calculation', { actualValue, predicted: lastPrediction.predicted, error: `${error.toFixed(2)}%` });
            }

            // 3. Add to history
            forecaster.addDataPoint(currentData.timestamp, actualValue);
            metrics.actualRps.set(actualValue);

            // 4. Generate prediction for 5 minutes ahead (10 intervals of 30s)
            const prediction = forecaster.predict(10);
            lastPrediction = {
                ...prediction,
                timestamp: Date.now(),
                actual_rps: actualValue
            };

            // 5. Update metrics
            metrics.predictedRps.set(prediction.predicted);
            metrics.confidenceScore.set(prediction.confidence);

            logger.info('Traffic Prediction Update', {
                actual_rps: actualValue.toFixed(2),
                predicted_rps_5m: prediction.predicted,
                trend: prediction.trend,
                confidence: prediction.confidence
            });

            // 6. Trigger Pre-scaling if threshold exceeded
            if (prediction.predicted > config.SCALING_THRESHOLD) {
                await triggerPreScaling(prediction.predicted, `Predicted traffic spike (${prediction.predicted} RPS)`);
            }

        } catch (error) {
            logger.error('Error in prediction loop', { error: error.message });
        }
    }, config.POLL_INTERVAL);
}

// Start Server
app.listen(config.PORT, () => {
    logger.info(`AI Predictor Service listening on port ${config.PORT}`);
    predictionLoop();
});
