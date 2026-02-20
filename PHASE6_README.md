# ResultShield - Phase 6: Observability

## 🎯 Phase 6 Goals
✅ Full-stack monitoring with Prometheus and Grafana  
✅ Real-time metrics from all services  
✅ Automated provisioning of dashboards and datasources  
✅ Proactive alerting based on p95 latency and queue length  

---

## 🛠️ Components

### 1. Prometheus
- **Endpoint**: `http://localhost:9090`
- **Config**: `infrastructure/prometheus/prometheus.yml`
- **Scrapes**:
  - `api-gateway` (3000)
  - `result-service-1,2,3` (8000)
  - `waiting-room` (8001)
  - `nginx` (8080)

### 2. Grafana
- **Endpoint**: `http://localhost:3001`
- **User**: `admin`
- **Pass**: `admin`
- **Features**:
  - Auto-provisioned datasource (Prometheus)
  - Auto-provisioned dashboard (ResultShield Main)

---

## 📊 Available Metrics

### HTTP Metrics
- `http_requests_total`: Request counts by method/status.
- `http_request_duration_seconds`: Response latency histogram.

### Service Specific
- `waiting_room_queue_length`: Current users in queue.
- `cache_hits_total` / `cache_misses_total`: Cache performance.
- `circuit_breaker_state`: 0 (Closed), 1 (Open), 2 (Half-Open).
- `db_query_duration_seconds`: Database query performance.

---

## 🚨 Alert Rules
Located at `infrastructure/prometheus/alert_rules.yml`.

- **HighLatency**: Triggers if p95 latency > 2s for 1m.
- **HighQueueLength**: Triggers if queue > 100 users for 2m.
- **DatabaseSlowQueries**: Triggers if p90 query > 1s for 1m.
- **CircuitBreakerOpen**: Critical alert if circuit breaker opens.

---

## 🚀 How to Access

1. **Prometheus**: Open `http://localhost:9090` to run manual queries.
2. **Grafana**: Open `http://localhost:3001`.
   - Go to **Dashboards** → **ResultShield** → **Main Dashboard**.
   - You will see real-time RPS, Latency, Cache Hit Ratio, and Circuit Breaker status.

---

## 🔧 Setup & Scaling
If you add more `result-service` instances, update the targets in `infrastructure/prometheus/prometheus.yml` and restart/reload Prometheus.

```bash
# Reload config without restart
curl -X POST http://localhost:9090/-/reload
```
