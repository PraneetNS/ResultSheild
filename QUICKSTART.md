# ResultShield - Quick Start Guide

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed:
- Docker Desktop (Windows/Mac) or Docker Engine (Linux)
- Docker Compose v2.0+
- Git
- k6 (for load testing) - [Installation Guide](https://k6.io/docs/getting-started/installation/)

### Installation Steps

#### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/resultshield.git
cd resultshield
```

#### 2. Start All Services

```bash
# Start all services in detached mode
docker-compose up -d

# View logs
docker-compose logs -f

# Check service status
docker-compose ps
```

#### 3. Wait for Services to Initialize

The system takes approximately 2-3 minutes to fully initialize. Monitor the logs:

```bash
docker-compose logs -f postgres-primary
docker-compose logs -f result-service-1
```

#### 4. Initialize Database

```bash
# Run database migrations (creates tables)
docker-compose exec result-service-1 python -c "
from app.core.database import init_db
import asyncio
asyncio.run(init_db())
"

# Seed sample data (10,000 students)
docker-compose exec result-service-1 python scripts/seed_data.py 10000
```

#### 5. Verify Services

Access the following endpoints to verify everything is running:

- **API Gateway**: http://localhost/health
- **Grafana Dashboard**: http://localhost:3001 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Redis Commander**: http://localhost:8081

### Testing the System

#### Manual API Testing

```bash
# Get a student result
curl http://localhost/api/v1/results/2024CS0001

# Check queue status
curl -H "X-User-ID: user123" http://localhost/api/v1/queue/status

# Get system stats
curl http://localhost/api/v1/stats
```

#### Load Testing with k6

```bash
# Run spike test (100K concurrent users)
k6 run --vus 100000 --duration 5m tests/load/spike-test.js

# Run gradual ramp-up test
k6 run tests/load/ramp-up-test.js

# Run with custom parameters
k6 run --vus 50000 --duration 3m tests/load/spike-test.js
```

### Monitoring

#### Grafana Dashboards

1. Open http://localhost:3001
2. Login with `admin` / `admin`
3. Navigate to Dashboards → ResultShield System Overview
4. View real-time metrics:
   - Requests per second
   - Response times (P95, P99)
   - Cache hit ratio
   - Queue depth
   - Error rates
   - Database performance

#### Prometheus Metrics

Access raw metrics at:
- http://localhost:9090/graph

Example queries:
```promql
# Request rate
rate(http_requests_total[5m])

# P95 latency
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Cache hit ratio
rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))
```

### Scaling Services

#### Scale API Gateway

```bash
# Scale to 4 instances
docker-compose up -d --scale api-gateway-1=2 --scale api-gateway-2=2

# Scale result service
docker-compose up -d --scale result-service-1=3 --scale result-service-2=3
```

#### Update Nginx Configuration

After scaling, update `infrastructure/nginx/nginx.conf` to include new instances:

```nginx
upstream api_gateway {
    server api-gateway-1:3000;
    server api-gateway-2:3000;
    server api-gateway-3:3000;  # Add new instances
    server api-gateway-4:3000;
}
```

Then reload Nginx:

```bash
docker-compose exec nginx nginx -s reload
```

### Troubleshooting

#### Services Not Starting

```bash
# Check logs for specific service
docker-compose logs result-service-1

# Restart a specific service
docker-compose restart result-service-1

# Rebuild and restart
docker-compose up -d --build result-service-1
```

#### Database Connection Issues

```bash
# Check PostgreSQL logs
docker-compose logs postgres-primary

# Connect to database manually
docker-compose exec postgres-primary psql -U resultshield -d resultshield

# Check connections
SELECT count(*) FROM pg_stat_activity;
```

#### Redis Connection Issues

```bash
# Check Redis logs
docker-compose logs redis-primary

# Connect to Redis CLI
docker-compose exec redis-primary redis-cli

# Check keys
KEYS *
```

#### High Memory Usage

```bash
# Check container stats
docker stats

# Limit container memory
# Edit docker-compose.yml and add:
deploy:
  resources:
    limits:
      memory: 1G
```

### Performance Tuning

#### Database Optimization

Edit `infrastructure/postgres/postgresql.conf`:

```conf
max_connections = 300
shared_buffers = 512MB
effective_cache_size = 2GB
work_mem = 8MB
```

#### Redis Optimization

```bash
# Increase max memory
docker-compose exec redis-primary redis-cli CONFIG SET maxmemory 4gb

# Change eviction policy
docker-compose exec redis-primary redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

#### Nginx Tuning

Edit `infrastructure/nginx/nginx.conf`:

```nginx
worker_processes auto;
worker_connections 8192;
keepalive_timeout 120;
```

### Clean Up

```bash
# Stop all services
docker-compose down

# Remove all data (including volumes)
docker-compose down -v

# Remove all images
docker-compose down --rmi all
```

### Next Steps

1. **Customize Configuration**: Edit `.env` files for each service
2. **Add Authentication**: Implement JWT-based authentication
3. **Deploy to Cloud**: Use Kubernetes manifests in `k8s/` directory
4. **Set Up CI/CD**: Configure GitHub Actions or Jenkins
5. **Add More Tests**: Expand test coverage with integration tests

### Support

For issues and questions:
- GitHub Issues: [Create an issue](https://github.com/yourusername/resultshield/issues)
- Documentation: See `docs/` directory
- Email: support@resultshield.com

---

**Built with ❤️ for handling 500K+ concurrent users**
