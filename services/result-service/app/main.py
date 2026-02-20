import os
import time
import uvicorn
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import structlog
from prometheus_client import make_asgi_app

from app.core.config import settings
from app.core.database import init_db, close_db
from app.core.redis_client import init_redis, close_redis
from app.api import results
from app.core.logging import setup_logging

# Setup logging
setup_logging()
logger = structlog.get_logger()

INSTANCE_ID = os.getenv("INSTANCE_ID", "result-service-unknown")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events"""
    # Startup
    logger.info("Starting Result Service", instance=settings.INSTANCE_ID)
    await init_db()
    await init_redis()

    # Initialize Prometheus metrics (Phase 6)
    from app.core.metrics import set_circuit_breaker_state
    set_circuit_breaker_state(settings.INSTANCE_ID, "CLOSED")

    logger.info("Result Service started successfully")

    yield

    # Shutdown
    logger.info("Shutting down Result Service")
    await close_db()
    await close_redis()
    logger.info("Result Service shutdown complete")


# Create FastAPI application
app = FastAPI(
    title="ResultShield - Result Service",
    description="High-performance result management service",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Prometheus HTTP Instrumentation Middleware ───────────────────────────────
# Tracks: http_requests_total, http_request_duration_seconds, http_errors_total
# Does NOT modify any business logic.
@app.middleware("http")
async def prometheus_http_middleware(request: Request, call_next):
    """Instrument every HTTP request with Prometheus metrics."""
    # Skip the /metrics endpoint itself
    if request.url.path == "/metrics":
        return await call_next(request)

    from app.core.metrics import (
        http_requests_total,
        http_request_duration_seconds,
        http_errors_total,
    )

    start = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start

    labels = {
        "method": request.method,
        "endpoint": request.url.path,
        "status_code": str(response.status_code),
        "service": "result-service",
        "instance": INSTANCE_ID,
    }

    http_requests_total.labels(**labels).inc()
    http_request_duration_seconds.labels(
        method=request.method,
        endpoint=request.url.path,
        service="result-service",
        instance=INSTANCE_ID,
    ).observe(duration)

    if response.status_code >= 400:
        http_errors_total.labels(**labels).inc()

    return response


# Correlation ID middleware
@app.middleware("http")
async def add_correlation_id(request: Request, call_next):
    """Propagate correlation ID from API Gateway"""
    correlation_id = request.headers.get("X-Correlation-ID", f"rs-{int(time.time())}")

    # Bind to logger context for all subsequent logs
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(correlation_id=correlation_id)

    response = await call_next(request)
    response.headers["X-Correlation-ID"] = correlation_id

    return response


# Logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all requests"""
    logger.info(
        "Incoming request",
        method=request.method,
        path=request.url.path,
        client=request.client.host if request.client else "unknown"
    )

    response = await call_next(request)

    logger.info(
        "Request completed",
        method=request.method,
        path=request.url.path,
        status_code=response.status_code
    )

    return response


# Exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler"""
    logger.error(
        "Unhandled exception",
        error=str(exc),
        path=request.url.path,
        method=request.method,
        exc_info=True
    )

    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal Server Error",
            "message": str(exc) if settings.DEBUG else "An unexpected error occurred"
        }
    )


# Include routers
app.include_router(results.router, prefix="/api", tags=["results"])


# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "result-service",
        "instance": settings.INSTANCE_ID,
        "version": "1.0.0"
    }


# Readiness check endpoint
@app.get("/ready")
async def readiness_check():
    """Readiness check endpoint"""
    from app.core.database import get_db_health
    from app.core.redis_client import get_redis_health

    db_healthy = await get_db_health()
    redis_healthy = await get_redis_health()

    if db_healthy and redis_healthy:
        return {
            "status": "ready",
            "database": "connected",
            "redis": "connected"
        }
    else:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not ready",
                "database": "connected" if db_healthy else "disconnected",
                "redis": "connected" if redis_healthy else "disconnected"
            }
        )


# Prometheus metrics endpoint
metrics_app = make_asgi_app()
app.mount("/metrics", metrics_app)


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.DEBUG,
        log_level="info"
    )
