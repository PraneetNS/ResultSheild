const client = require('prom-client');
const register = new client.Registry();

client.collectDefaultMetrics({ register });

const predictedRps = new client.Gauge({
    name: 'predicted_rps',
    help: 'Predicted requests per second 5 minutes ahead',
    registers: [register]
});

const actualRps = new client.Gauge({
    name: 'actual_rps',
    help: 'Current actual requests per second',
    registers: [register]
});

const predictionError = new client.Gauge({
    name: 'prediction_error',
    help: 'Mean percentage error between predicted and actual traffic',
    registers: [register]
});

const prescalingTriggeredTotal = new client.Counter({
    name: 'prescaling_triggered_total',
    help: 'Total number of times pre-scaling was triggered based on predictions',
    registers: [register]
});

const confidenceScore = new client.Gauge({
    name: 'prediction_confidence_score',
    help: 'Current confidence level of the prediction (0-1)',
    registers: [register]
});

module.exports = {
    register,
    metrics: {
        predictedRps,
        actualRps,
        predictionError,
        prescalingTriggeredTotal,
        confidenceScore
    }
};
