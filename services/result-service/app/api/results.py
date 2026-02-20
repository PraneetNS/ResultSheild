from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import OperationalError, TimeoutError as SQLTimeoutError
import structlog
import hashlib
import json
import os
from datetime import datetime
import asyncio

from app.core.database import get_db
from app.core.redis_client import get_cache_manager, CacheManager
from app.models.result import Result, ResultSnapshot, Student, AccessLog
from app.schemas.result import ResultResponse, ResultDetailResponse
from app.core.metrics import (
    http_requests_total, 
    http_request_duration_seconds,
    db_query_duration_seconds,
    cache_hits_total,
    cache_misses_total,
    set_circuit_breaker_state
)

router = APIRouter()
logger = structlog.get_logger()

# Circuit Breaker Configuration (Phase 4)
CIRCUIT_BREAKER_ENABLED = os.getenv("CIRCUIT_BREAKER_ENABLED", "true").lower() == "true"
CIRCUIT_BREAKER_THRESHOLD = int(os.getenv("CIRCUIT_BREAKER_THRESHOLD", "5"))
CIRCUIT_BREAKER_TIMEOUT = int(os.getenv("CIRCUIT_BREAKER_TIMEOUT", "30"))
DATABASE_QUERY_TIMEOUT = int(os.getenv("DATABASE_QUERY_TIMEOUT", "5000")) / 1000  # Convert to seconds
DEGRADED_MODE_ENABLED = os.getenv("DEGRADED_MODE_ENABLED", "true").lower() == "true"
INSTANCE_ID = os.getenv("INSTANCE_ID", "result-service-unknown")

# Circuit Breaker State (in-memory, per instance)
circuit_breaker_state = {
    "failures": 0,
    "last_failure_time": None,
    "state": "CLOSED"  # CLOSED, OPEN, HALF_OPEN
}


def check_circuit_breaker():
    """Check if circuit breaker allows request"""
    if not CIRCUIT_BREAKER_ENABLED:
        return True
    
    state = circuit_breaker_state["state"]
    
    if state == "CLOSED":
        return True
    
    if state == "OPEN":
        # Check if timeout has passed
        if circuit_breaker_state["last_failure_time"]:
            elapsed = (datetime.now() - circuit_breaker_state["last_failure_time"]).total_seconds()
            if elapsed >= CIRCUIT_BREAKER_TIMEOUT:
                circuit_breaker_state["state"] = "HALF_OPEN"
                set_circuit_breaker_state(INSTANCE_ID, "HALF_OPEN")
                logger.info("Circuit breaker transitioning to HALF_OPEN", instance=INSTANCE_ID)
                return True
        return False
    
    if state == "HALF_OPEN":
        return True
    
    return False


def record_success():
    """Record successful database operation"""
    if circuit_breaker_state["state"] == "HALF_OPEN":
        circuit_breaker_state["state"] = "CLOSED"
        circuit_breaker_state["failures"] = 0
        set_circuit_breaker_state(INSTANCE_ID, "CLOSED")
        logger.info("Circuit breaker CLOSED", instance=INSTANCE_ID)


def record_failure():
    """Record failed database operation"""
    if not CIRCUIT_BREAKER_ENABLED:
        return
    
    circuit_breaker_state["failures"] += 1
    circuit_breaker_state["last_failure_time"] = datetime.now()
    
    if circuit_breaker_state["failures"] >= CIRCUIT_BREAKER_THRESHOLD:
        circuit_breaker_state["state"] = "OPEN"
        set_circuit_breaker_state(INSTANCE_ID, "OPEN")
        logger.error(
            "Circuit breaker OPEN - database unavailable",
            failures=circuit_breaker_state["failures"],
            instance=INSTANCE_ID
        )


@router.get("/results/{roll_number}", response_model=ResultDetailResponse)
async def get_result(
    roll_number: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    cache: CacheManager = Depends(get_cache_manager)
):
    """
    Get student result with multi-layer caching and circuit breaker (Phase 4)
    
    1. Check Redis cache
    2. Check result snapshot (precomputed JSON)
    3. Query database with timeout
    4. If database fails, serve stale cache (graceful degradation)
    5. If overloaded, return waiting room response
    """
    start_time = datetime.now()
    request_id = request.headers.get("X-Request-ID", "unknown")
    cache_hit = False
    source = "database"
    degraded = False
    
    try:
        # Layer 1: Redis Cache
        cache_key = f"result:{roll_number}"
        cached_result = await cache.get(cache_key)
        
        if not cached_result:
            cache_misses_total.labels(instance=INSTANCE_ID).inc()
        
        if cached_result:
            cache_hits_total.labels(instance=INSTANCE_ID).inc()
            cache_hit = True
            source = "redis_cache"
            logger.info("Cache hit", roll_number=roll_number, source=source, instance=INSTANCE_ID)
            
            return ResultDetailResponse(
                **cached_result,
                metadata={
                    "cached": True,
                    "source": source,
                    "request_id": request_id,
                    "instance_id": INSTANCE_ID,
                    "generated_at": datetime.now().isoformat()
                }
            )
        
        # Check circuit breaker before database access (Phase 4)
        if not check_circuit_breaker():
            logger.warning(
                "Circuit breaker OPEN - serving stale cache",
                roll_number=roll_number,
                instance=INSTANCE_ID
            )
            
            # Try to serve stale cache
            stale_cache_key = f"stale:result:{roll_number}"
            stale_result = await cache.get(stale_cache_key)
            
            if stale_result:
                return ResultDetailResponse(
                    **stale_result,
                    metadata={
                        "cached": True,
                        "source": "stale_cache",
                        "degraded": True,
                        "request_id": request_id,
                        "instance_id": INSTANCE_ID,
                        "generated_at": datetime.now().isoformat(),
                        "message": "Serving cached data due to database issues"
                    }
                )
            
            # If no stale cache, return waiting room response
            if DEGRADED_MODE_ENABLED:
                return {
                    "waiting_room": True,
                    "message": "System is experiencing high load. Please try again in a moment.",
                    "estimated_wait_seconds": 30,
                    "request_id": request_id,
                    "instance_id": INSTANCE_ID
                }
            else:
                raise HTTPException(status_code=503, detail="Service temporarily unavailable")
        
        # Layer 2: Result Snapshot (Precomputed JSON)
        try:
            snapshot_query = select(ResultSnapshot).where(
                ResultSnapshot.roll_number == roll_number,
                ResultSnapshot.is_active == True
            )
            
            # Execute with timeout (Phase 4)
            db_start = datetime.now()
            snapshot_result = await asyncio.wait_for(
                db.execute(snapshot_query),
                timeout=DATABASE_QUERY_TIMEOUT
            )
            db_duration = (datetime.now() - db_start).total_seconds()
            db_query_duration_seconds.labels(operation="snapshot", service="result-service", instance=INSTANCE_ID).observe(db_duration)
            snapshot = snapshot_result.scalar_one_or_none()
            
            if snapshot:
                source = "snapshot"
                result_data = snapshot.snapshot_data
                
                # Cache in Redis (both normal and stale)
                await cache.set(cache_key, result_data, ttl=3600)
                await cache.set(f"stale:{cache_key}", result_data, ttl=86400)  # 24h stale cache
                
                logger.info("Snapshot hit", roll_number=roll_number, instance=INSTANCE_ID)
                
                record_success()  # Circuit breaker success
                
                return ResultDetailResponse(
                    **result_data,
                    metadata={
                        "cached": False,
                        "source": source,
                        "request_id": request_id,
                        "instance_id": INSTANCE_ID,
                        "generated_at": datetime.now().isoformat()
                    }
                )
        
        except (asyncio.TimeoutError, OperationalError, SQLTimeoutError) as e:
            logger.error(
                "Database timeout on snapshot query",
                roll_number=roll_number,
                error=str(e),
                instance=INSTANCE_ID
            )
            record_failure()  # Circuit breaker failure
            
            # Try stale cache
            stale_result = await cache.get(f"stale:{cache_key}")
            if stale_result and DEGRADED_MODE_ENABLED:
                degraded = True
                return ResultDetailResponse(
                    **stale_result,
                    metadata={
                        "cached": True,
                        "source": "stale_cache",
                        "degraded": True,
                        "request_id": request_id,
                        "instance_id": INSTANCE_ID,
                        "generated_at": datetime.now().isoformat(),
                        "message": "Serving cached data due to database timeout"
                    }
                )
            
            # Return waiting room if no stale cache
            if DEGRADED_MODE_ENABLED:
                return {
                    "waiting_room": True,
                    "message": "System is experiencing high load. Please try again.",
                    "estimated_wait_seconds": 60,
                    "request_id": request_id,
                    "instance_id": INSTANCE_ID
                }
            else:
                raise HTTPException(status_code=503, detail="Database timeout")
        
        # Layer 3: Database Query with timeout (Phase 4)
        try:
            # Get student info
            student_query = select(Student).where(Student.roll_number == roll_number)
            db_start = datetime.now()
            student_result = await asyncio.wait_for(
                db.execute(student_query),
                timeout=DATABASE_QUERY_TIMEOUT
            )
            db_duration = (datetime.now() - db_start).total_seconds()
            db_query_duration_seconds.labels(operation="student_info", service="result-service", instance=INSTANCE_ID).observe(db_duration)
            student = student_result.scalar_one_or_none()
            
            if not student:
                raise HTTPException(status_code=404, detail="Student not found")
            
            # Get all results for student
            results_query = select(Result).where(
                Result.roll_number == roll_number
            ).order_by(Result.semester)
            results_result = await asyncio.wait_for(
                db.execute(results_query),
                timeout=DATABASE_QUERY_TIMEOUT
            )
            results = results_result.scalars().all()
            
            if not results:
                raise HTTPException(status_code=404, detail="Results not found")
            
            # Compute overall result
            total_semesters = len(results)
            overall_cgpa = sum(r.cgpa for r in results if r.cgpa) / total_semesters if total_semesters > 0 else 0
            
            # Build response
            result_data = {
                "roll_number": roll_number,
                "student_name": student.name,
                "department": student.department,
                "batch": student.batch,
                "overall_cgpa": round(overall_cgpa, 2),
                "total_semesters": total_semesters,
                "semesters": [
                    {
                        "semester": r.semester,
                        "sgpa": r.sgpa,
                        "cgpa": r.cgpa,
                        "total_credits": r.total_credits,
                        "subjects": r.subjects,
                        "status": r.status,
                        "remarks": r.remarks
                    }
                    for r in results
                ]
            }
            
            # Cache in Redis (both normal and stale)
            await cache.set(cache_key, result_data, ttl=3600)
            await cache.set(f"stale:{cache_key}", result_data, ttl=86400)  # 24h stale cache
            
            logger.info("Database query", roll_number=roll_number, instance=INSTANCE_ID)
            
            record_success()  # Circuit breaker success
            
            return ResultDetailResponse(
                **result_data,
                metadata={
                    "cached": False,
                    "source": "database",
                    "request_id": request_id,
                    "instance_id": INSTANCE_ID,
                    "generated_at": datetime.now().isoformat()
                }
            )
        
        except (asyncio.TimeoutError, OperationalError, SQLTimeoutError) as e:
            logger.error(
                "Database timeout on full query",
                roll_number=roll_number,
                error=str(e),
                instance=INSTANCE_ID
            )
            record_failure()  # Circuit breaker failure
            
            # Try stale cache
            stale_result = await cache.get(f"stale:{cache_key}")
            if stale_result and DEGRADED_MODE_ENABLED:
                return ResultDetailResponse(
                    **stale_result,
                    metadata={
                        "cached": True,
                        "source": "stale_cache",
                        "degraded": True,
                        "request_id": request_id,
                        "instance_id": INSTANCE_ID,
                        "generated_at": datetime.now().isoformat(),
                        "message": "Serving cached data due to database timeout"
                    }
                )
            
            # Return waiting room
            if DEGRADED_MODE_ENABLED:
                return {
                    "waiting_room": True,
                    "message": "System is experiencing high load. Please try again.",
                    "estimated_wait_seconds": 90,
                    "request_id": request_id,
                    "instance_id": INSTANCE_ID
                }
            else:
                raise HTTPException(status_code=503, detail="Database timeout")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error fetching result", roll_number=roll_number, error=str(e), instance=INSTANCE_ID)
        
        # Try stale cache as last resort
        stale_result = await cache.get(f"stale:result:{roll_number}")
        if stale_result and DEGRADED_MODE_ENABLED:
            return ResultDetailResponse(
                **stale_result,
                metadata={
                    "cached": True,
                    "source": "stale_cache",
                    "degraded": True,
                    "request_id": request_id,
                    "instance_id": INSTANCE_ID,
                    "generated_at": datetime.now().isoformat(),
                    "message": "Serving cached data due to error"
                }
            )
        
        raise HTTPException(status_code=500, detail=str(e))



async def log_access(
    db: AsyncSession,
    roll_number: str,
    request: Request,
    request_id: str,
    response_time_ms: float,
    cache_hit: bool
):
    """Log access for analytics"""
    try:
        access_log = AccessLog(
            roll_number=roll_number,
            ip_address=request.client.host if request.client else "unknown",
            user_agent=request.headers.get("user-agent", "unknown"),
            request_id=request_id,
            response_time_ms=int(response_time_ms),
            cache_hit=cache_hit
        )
        db.add(access_log)
        await db.commit()
    except Exception as e:
        logger.error("Failed to log access", error=str(e))
        # Don't fail the request if logging fails
        pass


@router.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "result-api"}
