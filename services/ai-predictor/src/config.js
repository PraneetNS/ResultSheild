require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 8002,
    REDIS_URL: process.env.REDIS_URL || 'redis://redis-primary:6379',
    PROMETHEUS_URL: process.env.PROMETHEUS_URL || 'http://prometheus:9090',
    WAITING_ROOM_URL: process.env.WAITING_ROOM_URL || 'http://waiting-room:8001',
    API_GATEWAY_URL: process.env.API_GATEWAY_URL || 'http://api-gateway:3000',
    ENABLE_AI_PREDICTION: process.env.ENABLE_AI_PREDICTION === 'true',
    SCALING_THRESHOLD: parseFloat(process.env.SCALING_THRESHOLD) || 500, // Predicted RPS above this triggers scaling
    POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 30000, // 30 seconds
    PREDICTION_WINDOW: 300, // 300 seconds (5 minutes)
    HISTORY_LIMIT: parseInt(process.env.HISTORY_LIMIT) || 60 // Keep last 60 data points (30 mins of data at 30s interval)
};
