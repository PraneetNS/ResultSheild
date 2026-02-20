import redis.asyncio as redis
from typing import Optional, Any
import json
import structlog

from app.core.config import settings

logger = structlog.get_logger()

redis_client: Optional[redis.Redis] = None


async def init_redis():
    """Initialize Redis connection"""
    global redis_client
    
    try:
        redis_client = redis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            max_connections=settings.REDIS_MAX_CONNECTIONS
        )
        
        # Test connection
        await redis_client.ping()
        logger.info("Redis initialized successfully")
    except Exception as e:
        logger.error("Redis initialization failed", error=str(e))
        raise


async def close_redis():
    """Close Redis connection"""
    global redis_client
    
    if redis_client:
        await redis_client.close()
        logger.info("Redis connection closed")


def get_redis() -> redis.Redis:
    """Get Redis client"""
    if not redis_client:
        raise RuntimeError("Redis client not initialized")
    return redis_client


async def get_redis_health() -> bool:
    """Check Redis health"""
    try:
        await redis_client.ping()
        return True
    except Exception as e:
        logger.error("Redis health check failed", error=str(e))
        return False


class CacheManager:
    """Redis cache manager with helper methods"""
    
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client
        self.default_ttl = settings.REDIS_CACHE_TTL
    
    async def get(self, key: str) -> Optional[Any]:
        """Get value from cache"""
        try:
            value = await self.redis.get(key)
            if value:
                return json.loads(value)
            return None
        except Exception as e:
            logger.error("Cache get error", key=key, error=str(e))
            return None
    
    async def set(self, key: str, value: Any, ttl: Optional[int] = None) -> bool:
        """Set value in cache"""
        try:
            ttl = ttl or self.default_ttl
            await self.redis.setex(key, ttl, json.dumps(value))
            return True
        except Exception as e:
            logger.error("Cache set error", key=key, error=str(e))
            return False
    
    async def delete(self, key: str) -> bool:
        """Delete key from cache"""
        try:
            await self.redis.delete(key)
            return True
        except Exception as e:
            logger.error("Cache delete error", key=key, error=str(e))
            return False
    
    async def exists(self, key: str) -> bool:
        """Check if key exists"""
        try:
            return await self.redis.exists(key) > 0
        except Exception as e:
            logger.error("Cache exists error", key=key, error=str(e))
            return False
    
    async def increment(self, key: str, amount: int = 1) -> int:
        """Increment counter"""
        try:
            return await self.redis.incrby(key, amount)
        except Exception as e:
            logger.error("Cache increment error", key=key, error=str(e))
            return 0
    
    async def get_many(self, keys: list[str]) -> dict[str, Any]:
        """Get multiple values"""
        try:
            values = await self.redis.mget(keys)
            result = {}
            for key, value in zip(keys, values):
                if value:
                    result[key] = json.loads(value)
            return result
        except Exception as e:
            logger.error("Cache get_many error", error=str(e))
            return {}
    
    async def set_many(self, mapping: dict[str, Any], ttl: Optional[int] = None) -> bool:
        """Set multiple values"""
        try:
            ttl = ttl or self.default_ttl
            pipe = self.redis.pipeline()
            for key, value in mapping.items():
                pipe.setex(key, ttl, json.dumps(value))
            await pipe.execute()
            return True
        except Exception as e:
            logger.error("Cache set_many error", error=str(e))
            return False


def get_cache_manager() -> CacheManager:
    """Get cache manager instance"""
    return CacheManager(get_redis())
