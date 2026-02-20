# ResultShield - Phase 4: Extreme Traffic & Horizontal Scaling

## 🎯 Phase 4 Goals

✅ Nginx Load Balancer with health checks  
✅ Horizontal scaling (3 result-service instances)  
✅ k6 load testing (10K, 50K, 100K users)  
✅ Circuit breaker pattern  
✅ Graceful degradation  
✅ Request tracing across services  

---

## 🏗️ Architecture Diagram

```
                    ┌─────────────────────────────┐
                    │     k6 Load Testing         │
                    │  (10K / 50K / 100K users)   │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   Nginx Load Balancer        │
                    │   - Round Robin              │
                    │   - Health Checks            │
                    │   - Rate Limiting (basic)    │
                    │   - Request ID Propagation   │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
            ┌───────▼────────┐          ┌─────────▼────────┐
            │  API Gateway   │          │  Direct Access   │
            │  (Single)      │          │  (Load Testing)  │
            └───────┬────────┘          └─────────┬────────┘
                    │                             │
                    └──────────────┬──────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼──────┐         ┌─────────▼────────┐      ┌─────────▼────────┐
│ Result       │         │  Result          │      │  Result          │
│ Service 1    │         │  Service 2       │      │  Service 3       │
│              │         │                  │      │                  │
│ - Stateless  │         │  - Stateless     │      │  - Stateless     │
│ - Circuit    │         │  - Circuit       │      │  - Circuit       │
│   Breaker    │         │    Breaker       │      │    Breaker       │
│ - Degraded   │         │  - Degraded      │      │  - Degraded      │
│   Mode       │         │    Mode          │      │    Mode          │
└───────┬──────┘         └─────────┬────────┘      └─────────┬────────┘
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
            ┌───────▼──────┐              ┌───────▼──────┐
            │  PostgreSQL  │              │    Redis     │
            │   Primary    │              │   Primary    │
            │              │              │              │
            │ - Shared     │              │ - Shared     │
            │ - Timeout    │              │ - Cache      │
            │   5s         │              │ - Stale      │
            └──────────────┘              │   Cache      │
                                          └──────────────┘

                    ┌──────────────────────────────┐
                    │  Monitoring (Future Phase)   │
                    │  - Prometheus                │
                    │  - Grafana                   │
                    └──────────────────────────────┘
```

---

## 🚀 Phase 4 Features

### 1. Nginx Load Balancer

**Configuration**: `infrastructure/nginx/nginx.conf`

**Features**:
- **Round-robin** load balancing across 3 result-service instances
- **Health checks** with `max_fails=3` and `fail_timeout=30s`
- **Basic rate limiting** at Nginx level (100 req/s per IP)
- **Request ID propagation** for distributed tracing
- **Upstream retry** on failures

**Upstreams**:
```nginx
upstream result_service {
    least_conn;
    server result-service-1:8000 max_fails=3 fail_timeout=30s;
    server result-service-2:8000 max_fails=3 fail_timeout=30s;
    server result-service-3:8000 max_fails=3 fail_timeout=30s;
    keepalive 64;
}
```

### 2. Horizontal Scaling

**3 Result Service Instances**:
- `result-service-1` (Instance ID: result-service-1)
- `result-service-2` (Instance ID: result-service-2)
- `result-service-3` (Instance ID: result-service-3)

**Stateless Design**:
- ✅ No local state
- ✅ Shared Redis cache
- ✅ Shared PostgreSQL database
- ✅ Independent circuit breakers per instance

**Resource Limits** (per instance):
- CPU: 1 core
- Memory: 512MB

### 3. Circuit Breaker Pattern

**Implementation**: `services/result-service/app/api/results.py`

**States**:
1. **CLOSED**: Normal operation, all requests go to database
2. **OPEN**: Database failing, serve stale cache or waiting room
3. **HALF_OPEN**: Testing recovery, allow limited requests

**Configuration**:
```python
CIRCUIT_BREAKER_THRESHOLD = 5      # Failures before opening
CIRCUIT_BREAKER_TIMEOUT = 30       # Seconds before retry
DATABASE_QUERY_TIMEOUT = 5         # Query timeout in seconds
```

**Behavior**:
- After 5 consecutive failures → Circuit OPEN
- Wait 30 seconds → Transition to HALF_OPEN
- If next request succeeds → Circuit CLOSED
- If next request fails → Back to OPEN

### 4. Graceful Degradation

**Fallback Strategy** (in order):

1. **Redis Cache** (fastest, <10ms)
   - Hot data, 1-hour TTL

2. **Stale Cache** (when DB fails)
   - 24-hour TTL
   - Serves old data with `degraded: true` flag

3. **Waiting Room Response** (when overloaded)
   ```json
   {
     "waiting_room": true,
     "message": "System is experiencing high load. Please try again.",
     "estimated_wait_seconds": 60,
     "request_id": "req-123-456",
     "instance_id": "result-service-2"
   }
   ```

4. **503 Service Unavailable** (last resort)

### 5. Request Tracing

**Request ID Propagation**:

1. **Nginx** generates or forwards `X-Request-ID`
2. **API Gateway** propagates to result service
3. **Result Service** includes in response metadata

**Example**:
```bash
curl -H "X-Request-ID: my-trace-123" http://localhost/results/2024CS0001
```

**Response**:
```json
{
  "roll_number": "2024CS0001",
  "metadata": {
    "request_id": "my-trace-123",
    "instance_id": "result-service-2",
    "source": "redis_cache",
    "cached": true
  }
}
```

---

## 📊 Load Testing

### Test Scripts

Located in `tests/load/`:

1. **test-10k-users.js** - 10,000 concurrent users
2. **test-50k-users.js** - 50,000 concurrent users
3. **spike-test.js** - 100,000 concurrent users (EXTREME)

### Running Load Tests

```powershell
# Install k6
choco install k6

# Test 10K users
k6 run tests/load/test-10k-users.js

# Test 50K users
k6 run tests/load/test-50k-users.js

# Test 100K users (EXTREME)
k6 run tests/load/spike-test.js

# Custom test
k6 run --vus 25000 --duration 3m tests/load/test-10k-users.js
```

### Metrics Collected

**Standard Metrics**:
- `http_req_duration` - Response time (p95, p99)
- `http_req_failed` - Error rate
- `http_reqs` - Requests per second

**Custom Metrics**:
- `cache_hits` - Redis cache hits
- `cache_misses` - Cache misses
- `degraded_responses` - Stale cache served
- `waiting_room_responses` - Waiting room activated
- `active_virtual_users` - Current VU count

### Expected Results

#### 10K Users
- **RPS**: 5,000-8,000 req/s
- **P95 Latency**: <500ms
- **Error Rate**: <1%
- **Cache Hit Ratio**: >90%

#### 50K Users
- **RPS**: 15,000-25,000 req/s
- **P95 Latency**: <1000ms
- **Error Rate**: <5%
- **Cache Hit Ratio**: >85%

#### 100K Users (EXTREME)
- **RPS**: 30,000-50,000 req/s
- **P95 Latency**: <2000ms
- **Error Rate**: <20% (acceptable at extreme load)
- **Degraded Responses**: Expected
- **Waiting Room**: May activate

---

## 🔧 Configuration

### Environment Variables

**Result Service** (all 3 instances):
```env
DATABASE_URL=postgresql://resultshield:resultshield123@postgres-primary:5432/resultshield
DATABASE_POOL_SIZE=20
DATABASE_MAX_OVERFLOW=40
DATABASE_QUERY_TIMEOUT=5000           # 5 seconds
REDIS_URL=redis://redis-primary:6379
REDIS_CACHE_TTL=3600                  # 1 hour
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_THRESHOLD=5           # Failures before opening
CIRCUIT_BREAKER_TIMEOUT=30            # Seconds before retry
DEGRADED_MODE_ENABLED=true            # Enable graceful degradation
INSTANCE_ID=result-service-1          # Unique per instance
```

### Nginx Tuning

**Performance Settings**:
```nginx
worker_processes auto;
worker_connections 4096;
keepalive_timeout 65;
keepalive_requests 100;
```

**Rate Limiting**:
```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/s;
limit_req zone=api_limit burst=200 nodelay;
```

---

## 🧪 Testing the System

### 1. Start Services

```powershell
cd C:\Users\savan\OneDrive\Desktop\Result_shield
docker-compose up -d
```

### 2. Verify All Instances Running

```powershell
docker-compose ps

# Should show:
# - nginx (running)
# - api-gateway (running)
# - result-service-1 (running)
# - result-service-2 (running)
# - result-service-3 (running)
# - postgres-primary (running)
# - redis-primary (running)
```

### 3. Test Load Balancing

```powershell
# Make multiple requests
for ($i=1; $i -le 10; $i++) {
    curl http://localhost/results/2024CS0001
}

# Check logs to see different instances handling requests
docker-compose logs result-service-1 | Select-String "instance"
docker-compose logs result-service-2 | Select-String "instance"
docker-compose logs result-service-3 | Select-String "instance"
```

### 4. Test Circuit Breaker

```powershell
# Stop database
docker-compose stop postgres-primary

# Make requests - should serve stale cache or waiting room
curl http://localhost/results/2024CS0001

# Check for degraded mode
# Response should have: "degraded": true or "waiting_room": true

# Restart database
docker-compose start postgres-primary
```

### 5. Test Request Tracing

```powershell
# Send request with custom trace ID
curl -H "X-Request-ID: trace-12345" http://localhost/results/2024CS0001

# Response should include:
# "request_id": "trace-12345"
# "instance_id": "result-service-X"
```

### 6. Run Load Test

```powershell
# Start with 10K users
k6 run tests/load/test-10k-users.js

# Monitor logs
docker-compose logs -f result-service-1
docker-compose logs -f nginx
```

---

## 📈 Monitoring

### Check Service Health

```powershell
# Nginx health
curl http://localhost:8080/nginx-health

# API Gateway health
curl http://localhost/api/v1/health

# Result Service health (through LB)
curl http://localhost/results/health
```

### View Logs

```powershell
# All services
docker-compose logs -f

# Specific instance
docker-compose logs -f result-service-2

# Nginx access logs
docker-compose exec nginx tail -f /var/log/nginx/access.log

# Nginx error logs
docker-compose exec nginx tail -f /var/log/nginx/error.log
```

### Check Circuit Breaker State

```powershell
# Check logs for circuit breaker events
docker-compose logs result-service-1 | Select-String "Circuit breaker"

# Look for:
# - "Circuit breaker OPEN"
# - "Circuit breaker HALF_OPEN"
# - "Circuit breaker CLOSED"
```

---

## 🎯 Performance Tuning

### Database Optimization

```sql
-- Check connection pool
SELECT count(*) FROM pg_stat_activity;

-- Check slow queries
SELECT query, mean_exec_time 
FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;
```

### Redis Optimization

```bash
# Check memory usage
docker-compose exec redis-primary redis-cli INFO memory

# Check hit rate
docker-compose exec redis-primary redis-cli INFO stats | grep hit

# Check key count
docker-compose exec redis-primary redis-cli DBSIZE
```

### Nginx Optimization

```bash
# Check active connections
docker-compose exec nginx cat /var/log/nginx/access.log | wc -l

# Check error rate
docker-compose exec nginx grep "error" /var/log/nginx/error.log | wc -l
```

---

## 🚨 Troubleshooting

### High Error Rate

**Symptoms**: Error rate >10% during load test

**Solutions**:
1. Check database connections: `docker-compose logs postgres-primary`
2. Increase connection pool: Edit `DATABASE_POOL_SIZE` to 30
3. Increase circuit breaker threshold: Set `CIRCUIT_BREAKER_THRESHOLD=10`
4. Scale result service: Add more instances

### Circuit Breaker Always Open

**Symptoms**: All requests return stale cache or waiting room

**Solutions**:
1. Check database is running: `docker-compose ps postgres-primary`
2. Check database timeout: Increase `DATABASE_QUERY_TIMEOUT` to 10000
3. Reset circuit breaker: Restart result services
4. Check database logs for errors

### Low Cache Hit Ratio

**Symptoms**: Cache hit ratio <70%

**Solutions**:
1. Increase Redis memory: Edit `maxmemory 2gb` in docker-compose
2. Increase cache TTL: Set `REDIS_CACHE_TTL=7200`
3. Pre-warm cache: Run seeding script
4. Check eviction policy: Should be `allkeys-lru`

### Nginx 502 Bad Gateway

**Symptoms**: Nginx returns 502 errors

**Solutions**:
1. Check result services are running: `docker-compose ps`
2. Check upstream health: `curl http://localhost/upstream-health`
3. Increase upstream timeout in nginx.conf
4. Check result service logs for crashes

---

## 📝 Phase 4 Checklist

✅ **Infrastructure**
- [x] Nginx load balancer configured
- [x] 3 result-service instances running
- [x] Shared PostgreSQL database
- [x] Shared Redis cache
- [x] Network isolation

✅ **Features**
- [x] Round-robin load balancing
- [x] Health checks on upstreams
- [x] Circuit breaker pattern
- [x] Graceful degradation
- [x] Stale cache serving
- [x] Waiting room response
- [x] Request ID tracing

✅ **Testing**
- [x] k6 load test scripts (10K, 50K, 100K)
- [x] Custom metrics collection
- [x] Performance thresholds defined
- [x] Test summary reports

✅ **Documentation**
- [x] Architecture diagram
- [x] Configuration guide
- [x] Testing guide
- [x] Troubleshooting guide

---

## 🎉 Phase 4 Complete!

**What We Built**:
- ✅ Nginx LB with 3 result-service instances
- ✅ Circuit breaker with graceful degradation
- ✅ Request tracing across services
- ✅ Load testing for 10K/50K/100K users
- ✅ Stale cache fallback
- ✅ Waiting room response

**Next Phase** (Future):
- Monitoring with Prometheus & Grafana
- Virtual waiting room service
- AI traffic prediction
- Multi-region deployment

---

**Phase 4 demonstrates production-grade horizontal scaling and resilience patterns!** 🚀
