"""
Prometheus Metrics - Result Service (Phase 6: Observability)

Exposes all required metrics:
  HTTP Layer, Cache, Database, System, Circuit Breaker
Does NOT change any business logic.
"""

import os
import time
import psutil
import threading
from prometheus_client import Counter, Histogram, Gauge, REGISTRY

INSTANCE_ID = os.getenv("INSTANCE_ID", "result-service-unknown")

# ─── HTTP Layer ───────────────────────────────────────────────────────────────

http_requests_total = Counter(
    'http_requests_total',
    'Total HTTP Requests',
    ['method', 'endpoint', 'status_code', 'service', 'instance']
)

http_request_duration_seconds = Histogram(
    'http_request_duration_seconds',
    'HTTP Request Duration in seconds',
    ['method', 'endpoint', 'service', 'instance'],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
)

http_errors_total = Counter(
    'http_errors_total',
    'Total HTTP errors (4xx + 5xx)',
    ['method', 'endpoint', 'status_code', 'service', 'instance']
)

# ─── Database Metrics ─────────────────────────────────────────────────────────

db_query_duration_seconds = Histogram(
    'db_query_duration_seconds',
    'Database query duration in seconds',
    ['operation', 'service', 'instance'],
    buckets=[0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
)

db_errors_total = Counter(
    'db_errors_total',
    'Total database errors',
    ['operation', 'service', 'instance']
)

db_connection_pool_usage = Gauge(
    'db_connection_pool_usage',
    'Number of connections currently checked out from the pool',
    ['service', 'instance']
)

# ─── Cache (Redis) Metrics ────────────────────────────────────────────────────

redis_cache_hits_total = Counter(
    'redis_cache_hits_total',
    'Total Redis cache hits',
    ['service', 'instance']
)

redis_cache_misses_total = Counter(
    'redis_cache_misses_total',
    'Total Redis cache misses',
    ['service', 'instance']
)

redis_latency_seconds = Histogram(
    'redis_latency_seconds',
    'Redis operation latency in seconds',
    ['service', 'instance', 'operation'],
    buckets=[0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5]
)

# ─── Backward-compat aliases (used in results.py) ────────────────────────────
# These wrap the new canonical metrics so existing call sites need no changes.

class _CacheHitsCompat:
    """Wraps redis_cache_hits_total with the old .labels(instance=...).inc() API"""
    def labels(self, instance=INSTANCE_ID):
        return _CompatInc(redis_cache_hits_total, {'service': 'result-service', 'instance': instance})

class _CacheMissesCompat:
    """Wraps redis_cache_misses_total with the old .labels(instance=...).inc() API"""
    def labels(self, instance=INSTANCE_ID):
        return _CompatInc(redis_cache_misses_total, {'service': 'result-service', 'instance': instance})

class _CompatInc:
    def __init__(self, counter, labels):
        self._counter = counter
        self._labels = labels
    def inc(self, amount=1):
        self._counter.labels(**self._labels).inc(amount)

# Old names still used in results.py
cache_hits_total = _CacheHitsCompat()
cache_misses_total = _CacheMissesCompat()

# ─── Circuit Breaker Metrics ──────────────────────────────────────────────────

circuit_breaker_state = Gauge(
    'circuit_breaker_state',
    'Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
    ['service', 'instance']
)

def set_circuit_breaker_state(instance: str, state_str: str):
    state_map = {"CLOSED": 0, "OPEN": 1, "HALF_OPEN": 2}
    state_val = state_map.get(state_str, 0)
    circuit_breaker_state.labels(service='result-service', instance=instance).set(state_val)

# ─── System Metrics ───────────────────────────────────────────────────────────

cpu_usage_percent = Gauge(
    'cpu_usage_percent',
    'CPU usage percentage',
    ['service', 'instance']
)

memory_usage_bytes = Gauge(
    'memory_usage_bytes',
    'Memory usage in bytes',
    ['service', 'instance', 'type']
)

def _collect_system_metrics():
    """Background thread: collect system metrics every 5 seconds."""
    import os as _os
    proc = psutil.Process(_os.getpid())
    while True:
        try:
            cpu = proc.cpu_percent(interval=None)
            cpu_usage_percent.labels(service='result-service', instance=INSTANCE_ID).set(cpu)

            mem = proc.memory_info()
            memory_usage_bytes.labels(service='result-service', instance=INSTANCE_ID, type='rss').set(mem.rss)
            memory_usage_bytes.labels(service='result-service', instance=INSTANCE_ID, type='vms').set(mem.vms)
        except Exception:
            pass
        time.sleep(5)

# Start background collector (daemon so it doesn't block shutdown)
_sys_thread = threading.Thread(target=_collect_system_metrics, daemon=True)
_sys_thread.start()
