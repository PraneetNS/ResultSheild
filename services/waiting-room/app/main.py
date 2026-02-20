import asyncio
import time
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import redis.asyncio as redis
import structlog
import json
from datetime import datetime
from prometheus_client import Counter, Gauge, Histogram, make_asgi_app

# Setup logging
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer()
    ]
)
logger = structlog.get_logger()

app = FastAPI(title="ResultShield - Waiting Room Service")

# Prometheus metrics
queue_depth = Gauge('waiting_room_queue_depth', 'Current queue depth')
queue_joins = Counter('waiting_room_queue_joins_total', 'Total queue joins')
queue_exits = Counter('waiting_room_queue_exits_total', 'Total queue exits')
wait_time = Histogram('waiting_room_wait_time_seconds', 'Wait time in queue')

# Configuration
REDIS_URL = "redis://redis-primary:6379"
QUEUE_CAPACITY = 10000
THROUGHPUT_PER_SECOND = 1000
CHECK_INTERVAL = 1

redis_client = None


@app.on_event("startup")
async def startup():
    global redis_client
    redis_client = await redis.from_url(REDIS_URL, decode_responses=True)
    logger.info("Waiting room service started")
    
    # Start background queue processor
    asyncio.create_task(process_queue())


@app.on_event("shutdown")
async def shutdown():
    if redis_client:
        await redis_client.close()
    logger.info("Waiting room service stopped")


class QueueJoinRequest(BaseModel):
    user_id: str


class QueueStatusResponse(BaseModel):
    position: int
    estimated_wait_time: int
    queue_length: int
    status: str


@app.post("/api/queue/join")
async def join_queue(request: QueueJoinRequest):
    """Add user to virtual waiting room queue"""
    user_id = request.user_id
    
    try:
        # Check if user already in queue
        existing_position = await redis_client.zrank("waiting_queue", user_id)
        
        if existing_position is not None:
            queue_length = await redis_client.zcard("waiting_queue")
            position = existing_position + 1
            
            return {
                "status": "already_in_queue",
                "position": position,
                "queue_length": queue_length,
                "estimated_wait_time": calculate_wait_time(position)
            }
        
        # Add to queue with timestamp as score
        timestamp = time.time()
        await redis_client.zadd("waiting_queue", {user_id: timestamp})
        
        # Get position
        position = await redis_client.zrank("waiting_queue", user_id) + 1
        queue_length = await redis_client.zcard("waiting_queue")
        
        # Update metrics
        queue_joins.inc()
        queue_depth.set(queue_length)
        
        logger.info("User joined queue", user_id=user_id, position=position)
        
        return {
            "status": "queued",
            "position": position,
            "queue_length": queue_length,
            "estimated_wait_time": calculate_wait_time(position),
            "joined_at": datetime.fromtimestamp(timestamp).isoformat()
        }
        
    except Exception as e:
        logger.error("Queue join error", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/queue/status/{user_id}")
async def get_queue_status(user_id: str):
    """Get user's position in queue"""
    try:
        position = await redis_client.zrank("waiting_queue", user_id)
        
        if position is None:
            # Check if user has access token (already processed)
            has_access = await redis_client.exists(f"access_token:{user_id}")
            
            if has_access:
                return {
                    "status": "granted",
                    "message": "Access granted, you can proceed"
                }
            else:
                raise HTTPException(status_code=404, detail="Not in queue")
        
        queue_length = await redis_client.zcard("waiting_queue")
        actual_position = position + 1
        
        return {
            "status": "waiting",
            "position": actual_position,
            "queue_length": queue_length,
            "estimated_wait_time": calculate_wait_time(actual_position)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Queue status error", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/queue/leave/{user_id}")
async def leave_queue(user_id: str):
    """Remove user from queue"""
    try:
        removed = await redis_client.zrem("waiting_queue", user_id)
        
        if removed:
            queue_exits.inc()
            queue_length = await redis_client.zcard("waiting_queue")
            queue_depth.set(queue_length)
            
            logger.info("User left queue", user_id=user_id)
            return {"status": "removed", "message": "Successfully left queue"}
        else:
            raise HTTPException(status_code=404, detail="Not in queue")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Queue leave error", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


async def process_queue():
    """Background task to process queue and grant access"""
    while True:
        try:
            # Get users to process (based on throughput)
            users_to_process = await redis_client.zrange(
                "waiting_queue", 
                0, 
                THROUGHPUT_PER_SECOND - 1
            )
            
            if users_to_process:
                for user_id in users_to_process:
                    # Grant access token
                    await redis_client.setex(
                        f"access_token:{user_id}",
                        300,  # 5 minutes validity
                        "granted"
                    )
                    
                    # Get join timestamp for wait time calculation
                    score = await redis_client.zscore("waiting_queue", user_id)
                    if score:
                        wait_duration = time.time() - score
                        wait_time.observe(wait_duration)
                    
                    # Remove from queue
                    await redis_client.zrem("waiting_queue", user_id)
                    queue_exits.inc()
                    
                    logger.info("Access granted", user_id=user_id)
                
                # Update queue depth
                queue_length = await redis_client.zcard("waiting_queue")
                queue_depth.set(queue_length)
            
            await asyncio.sleep(CHECK_INTERVAL)
            
        except Exception as e:
            logger.error("Queue processing error", error=str(e))
            await asyncio.sleep(CHECK_INTERVAL)


def calculate_wait_time(position: int) -> int:
    """Calculate estimated wait time in seconds"""
    return max(0, int(position / THROUGHPUT_PER_SECOND))


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "waiting-room"}


@app.get("/metrics")
async def metrics():
    """Expose Prometheus metrics"""
    return make_asgi_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
