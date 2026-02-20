import asyncio
import time
from datetime import datetime, timedelta
from fastapi import FastAPI
import redis.asyncio as redis
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
import joblib
import structlog
import json
from prometheus_client import Gauge, make_asgi_app

# Setup logging
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer()
    ]
)
logger = structlog.get_logger()

app = FastAPI(title="ResultShield - AI Traffic Predictor")

# Prometheus metrics
predicted_traffic = Gauge('predicted_traffic_next_hour', 'Predicted traffic for next hour')
current_traffic = Gauge('current_traffic_rate', 'Current traffic rate')
adaptive_rate_limit = Gauge('adaptive_rate_limit', 'Adaptive rate limit threshold')

# Configuration
REDIS_URL = "redis://redis-primary:6379"
MODEL_UPDATE_INTERVAL = 300  # 5 minutes
PREDICTION_WINDOW = 3600  # 1 hour

redis_client = None
traffic_model = None
scaler = StandardScaler()


@app.on_event("startup")
async def startup():
    global redis_client
    redis_client = await redis.from_url(REDIS_URL, decode_responses=True)
    logger.info("AI Predictor service started")
    
    # Start background tasks
    asyncio.create_task(collect_traffic_data())
    asyncio.create_task(train_model_periodically())
    asyncio.create_task(make_predictions())


@app.on_event("shutdown")
async def shutdown():
    if redis_client:
        await redis_client.close()
    logger.info("AI Predictor service stopped")


async def collect_traffic_data():
    """Collect traffic metrics for training"""
    while True:
        try:
            # Get current request count from Redis
            current_count = await redis_client.get("metrics:requests:total")
            
            if current_count:
                timestamp = int(time.time())
                
                # Store traffic data point
                traffic_data = {
                    "timestamp": timestamp,
                    "requests": int(current_count),
                    "hour": datetime.fromtimestamp(timestamp).hour,
                    "day_of_week": datetime.fromtimestamp(timestamp).weekday(),
                    "minute": datetime.fromtimestamp(timestamp).minute
                }
                
                # Store in Redis sorted set (last 24 hours)
                await redis_client.zadd(
                    "traffic_history",
                    {json.dumps(traffic_data): timestamp}
                )
                
                # Remove old data (older than 7 days)
                cutoff = timestamp - (7 * 24 * 3600)
                await redis_client.zremrangebyscore("traffic_history", 0, cutoff)
                
                # Update current traffic metric
                current_traffic.set(int(current_count))
            
            await asyncio.sleep(60)  # Collect every minute
            
        except Exception as e:
            logger.error("Traffic collection error", error=str(e))
            await asyncio.sleep(60)


async def train_model_periodically():
    """Train prediction model periodically"""
    global traffic_model, scaler
    
    while True:
        try:
            # Get historical traffic data
            traffic_history = await redis_client.zrange(
                "traffic_history",
                0,
                -1,
                withscores=False
            )
            
            if len(traffic_history) < 100:
                logger.info("Insufficient data for training", count=len(traffic_history))
                await asyncio.sleep(MODEL_UPDATE_INTERVAL)
                continue
            
            # Parse data
            data_points = []
            for item in traffic_history:
                try:
                    data_points.append(json.loads(item))
                except:
                    continue
            
            if len(data_points) < 100:
                await asyncio.sleep(MODEL_UPDATE_INTERVAL)
                continue
            
            # Create DataFrame
            df = pd.DataFrame(data_points)
            
            # Feature engineering
            df['hour_sin'] = np.sin(2 * np.pi * df['hour'] / 24)
            df['hour_cos'] = np.cos(2 * np.pi * df['hour'] / 24)
            df['day_sin'] = np.sin(2 * np.pi * df['day_of_week'] / 7)
            df['day_cos'] = np.cos(2 * np.pi * df['day_of_week'] / 7)
            
            # Prepare features and target
            features = ['hour_sin', 'hour_cos', 'day_sin', 'day_cos', 'minute']
            X = df[features].values
            y = df['requests'].values
            
            # Scale features
            X_scaled = scaler.fit_transform(X)
            
            # Train model
            model = LinearRegression()
            model.fit(X_scaled, y)
            
            traffic_model = model
            
            # Calculate model score
            score = model.score(X_scaled, y)
            logger.info("Model trained", score=score, samples=len(df))
            
            # Store model in Redis
            model_data = {
                "coefficients": model.coef_.tolist(),
                "intercept": float(model.intercept_),
                "score": score,
                "trained_at": datetime.now().isoformat()
            }
            await redis_client.set("ai_model:traffic", json.dumps(model_data))
            
            await asyncio.sleep(MODEL_UPDATE_INTERVAL)
            
        except Exception as e:
            logger.error("Model training error", error=str(e), exc_info=True)
            await asyncio.sleep(MODEL_UPDATE_INTERVAL)


async def make_predictions():
    """Make traffic predictions and adjust rate limits"""
    global traffic_model
    
    while True:
        try:
            if traffic_model is None:
                await asyncio.sleep(60)
                continue
            
            # Predict traffic for next hour
            now = datetime.now()
            future_time = now + timedelta(hours=1)
            
            # Create features for prediction
            features = np.array([[
                np.sin(2 * np.pi * future_time.hour / 24),
                np.cos(2 * np.pi * future_time.hour / 24),
                np.sin(2 * np.pi * future_time.weekday() / 7),
                np.cos(2 * np.pi * future_time.weekday() / 7),
                future_time.minute
            ]])
            
            # Scale and predict
            features_scaled = scaler.transform(features)
            prediction = traffic_model.predict(features_scaled)[0]
            
            # Update metric
            predicted_traffic.set(max(0, prediction))
            
            # Calculate adaptive rate limit
            # Base rate limit: 100 req/s
            # Increase if predicted traffic is high
            base_limit = 100
            traffic_multiplier = min(5.0, max(0.5, prediction / 10000))
            new_limit = int(base_limit * traffic_multiplier)
            
            # Store adaptive rate limit
            await redis_client.set("adaptive_rate_limit", new_limit)
            adaptive_rate_limit.set(new_limit)
            
            logger.info(
                "Traffic prediction",
                predicted=int(prediction),
                adaptive_limit=new_limit,
                for_time=future_time.isoformat()
            )
            
            await asyncio.sleep(300)  # Predict every 5 minutes
            
        except Exception as e:
            logger.error("Prediction error", error=str(e), exc_info=True)
            await asyncio.sleep(300)


@app.get("/api/predict")
async def get_prediction():
    """Get traffic prediction"""
    try:
        model_data = await redis_client.get("ai_model:traffic")
        adaptive_limit = await redis_client.get("adaptive_rate_limit")
        
        if not model_data:
            return {
                "status": "no_model",
                "message": "Model not trained yet"
            }
        
        model_info = json.loads(model_data)
        
        return {
            "status": "active",
            "model": {
                "score": model_info["score"],
                "trained_at": model_info["trained_at"]
            },
            "predicted_traffic": predicted_traffic._value.get(),
            "current_traffic": current_traffic._value.get(),
            "adaptive_rate_limit": int(adaptive_limit) if adaptive_limit else 100
        }
        
    except Exception as e:
        logger.error("Get prediction error", error=str(e))
        return {"status": "error", "message": str(e)}


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "ai-predictor"}


# Mount Prometheus metrics
metrics_app = make_asgi_app()
app.mount("/metrics", metrics_app)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
