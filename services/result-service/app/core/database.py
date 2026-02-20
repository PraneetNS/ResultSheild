import os
import time
import threading
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy.pool import NullPool, QueuePool
import structlog

from app.core.config import settings

logger = structlog.get_logger()
INSTANCE_ID = os.getenv("INSTANCE_ID", "result-service-unknown")

# Create async engine
engine = create_async_engine(
    settings.DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://"),
    poolclass=QueuePool,
    pool_size=settings.DATABASE_POOL_SIZE,
    max_overflow=settings.DATABASE_MAX_OVERFLOW,
    pool_timeout=settings.DATABASE_POOL_TIMEOUT,
    pool_recycle=settings.DATABASE_POOL_RECYCLE,
    pool_pre_ping=True,
    echo=settings.DEBUG
)

# Create session factory
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False
)

# Base class for models
Base = declarative_base()


def _poll_pool_metrics():
    """Background thread: update db_connection_pool_usage every 5 seconds."""
    while True:
        try:
            from app.core.metrics import db_connection_pool_usage
            pool = engine.pool
            # checkedout() = connections currently in use by the application
            checked_out = pool.checkedout() if hasattr(pool, 'checkedout') else 0
            db_connection_pool_usage.labels(
                service='result-service',
                instance=INSTANCE_ID
            ).set(checked_out)
        except Exception:
            pass
        time.sleep(5)

_pool_thread = threading.Thread(target=_poll_pool_metrics, daemon=True)
_pool_thread.start()


async def init_db():
    """Initialize database connection"""
    try:
        async with engine.begin() as conn:
            # Create tables if they don't exist
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database initialized successfully")
    except Exception as e:
        logger.error("Database initialization failed", error=str(e))
        raise


async def close_db():
    """Close database connection"""
    await engine.dispose()
    logger.info("Database connection closed")


async def get_db():
    """Dependency to get database session"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def get_db_health() -> bool:
    """Check database health"""
    try:
        async with AsyncSessionLocal() as session:
            await session.execute("SELECT 1")
        return True
    except Exception as e:
        logger.error("Database health check failed", error=str(e))
        return False
