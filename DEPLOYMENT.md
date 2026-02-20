# ResultShield - Complete Deployment Guide

## 🎯 Deployment Options

ResultShield can be deployed in multiple environments:

1. **Local Development** (Docker Compose)
2. **Production** (Kubernetes)
3. **Cloud Platforms** (AWS, GCP, Azure)

---

## 1️⃣ Local Development (Docker Compose)

### Prerequisites

- Windows 10/11 with WSL2
- Docker Desktop for Windows
- 8GB RAM minimum (16GB recommended)
- 20GB free disk space

### Step-by-Step Setup

#### Step 1: Install Docker Desktop

1. Download from: https://www.docker.com/products/docker-desktop
2. Install and enable WSL2 backend
3. Allocate resources in Docker Desktop settings:
   - CPUs: 4
   - Memory: 8GB
   - Swap: 2GB

#### Step 2: Clone Repository

```powershell
cd C:\Users\savan\OneDrive\Desktop
git clone <your-repo-url> Result_shield
cd Result_shield
```

#### Step 3: Run Automated Setup

```powershell
# Run the setup script
.\setup.ps1

# This will:
# - Check prerequisites
# - Create directories
# - Copy environment files
# - Start all services
# - Initialize database
# - Seed sample data
```

#### Step 4: Verify Installation

```powershell
# Check all services are running
docker-compose ps

# Should show:
# - nginx (running)
# - api-gateway-1, api-gateway-2 (running)
# - result-service-1, result-service-2 (running)
# - waiting-room (running)
# - ai-predictor (running)
# - postgres-primary, postgres-replica-1, postgres-replica-2 (running)
# - redis-primary (running)
# - prometheus (running)
# - grafana (running)
```

#### Step 5: Test the System

```powershell
# Test API
curl http://localhost/api/v1/results/2024CS0001

# Expected response:
# {
#   "roll_number": "2024CS0001",
#   "student_name": "Student 1",
#   "department": "Computer Science",
#   ...
# }
```

### Manual Setup (Alternative)

If the automated script fails, follow these manual steps:

```powershell
# 1. Create environment files
Copy-Item services\api-gateway\.env.example services\api-gateway\.env
Copy-Item services\result-service\.env.example services\result-service\.env

# 2. Start services
docker-compose up -d

# 3. Wait for initialization
Start-Sleep -Seconds 30

# 4. Initialize database
docker-compose exec result-service-1 python -c "from app.core.database import init_db; import asyncio; asyncio.run(init_db())"

# 5. Seed data
docker-compose exec result-service-1 python scripts/seed_data.py 10000

# 6. Check health
curl http://localhost/health
```

---

## 2️⃣ Load Testing

### Install k6

```powershell
# Using Chocolatey
choco install k6

# Or download from: https://k6.io/docs/getting-started/installation/
```

### Run Load Tests

```powershell
# Spike test (100K users)
k6 run --vus 100000 --duration 5m tests/load/spike-test.js

# Gradual ramp-up
k6 run tests/load/ramp-up-test.js

# Custom test
k6 run --vus 50000 --duration 3m --out json=results.json tests/load/spike-test.js
```

### Analyze Results

```powershell
# View Grafana dashboard
Start-Process http://localhost:3001

# Login: admin / admin
# Navigate to: Dashboards → ResultShield System Overview
```

---

## 3️⃣ Monitoring & Debugging

### View Logs

```powershell
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f result-service-1

# Last 100 lines
docker-compose logs --tail=100 api-gateway-1
```

### Access Monitoring Tools

```powershell
# Grafana (Dashboards)
Start-Process http://localhost:3001

# Prometheus (Metrics)
Start-Process http://localhost:9090

# Redis Commander (Cache viewer)
Start-Process http://localhost:8081
```

### Check Service Health

```powershell
# API Gateway
curl http://localhost/health

# Result Service
curl http://localhost:8000/health

# Waiting Room
curl http://localhost:8001/health

# AI Predictor
curl http://localhost:8002/health
```

### Database Access

```powershell
# Connect to PostgreSQL
docker-compose exec postgres-primary psql -U resultshield -d resultshield

# Run queries
SELECT COUNT(*) FROM students;
SELECT COUNT(*) FROM results;
SELECT COUNT(*) FROM result_snapshots;

# Exit
\q
```

### Redis Access

```powershell
# Connect to Redis CLI
docker-compose exec redis-primary redis-cli

# Check keys
KEYS *

# Get cache stats
INFO stats

# Exit
exit
```

---

## 4️⃣ Scaling

### Horizontal Scaling

```powershell
# Scale API Gateway to 4 instances
docker-compose up -d --scale api-gateway-1=2 --scale api-gateway-2=2

# Scale Result Service to 6 instances
docker-compose up -d --scale result-service-1=3 --scale result-service-2=3

# Verify
docker-compose ps
```

### Update Load Balancer

After scaling, update Nginx configuration:

1. Edit `infrastructure/nginx/nginx.conf`
2. Add new upstream servers
3. Reload Nginx:

```powershell
docker-compose exec nginx nginx -s reload
```

---

## 5️⃣ Troubleshooting

### Services Not Starting

```powershell
# Check Docker is running
docker version

# Check logs for errors
docker-compose logs

# Restart specific service
docker-compose restart result-service-1

# Rebuild and restart
docker-compose up -d --build result-service-1
```

### Port Conflicts

If ports are already in use:

1. Edit `docker-compose.yml`
2. Change port mappings:
   ```yaml
   ports:
     - "8080:80"  # Change 80 to 8080
   ```
3. Restart services

### Database Connection Errors

```powershell
# Check PostgreSQL is running
docker-compose ps postgres-primary

# Check logs
docker-compose logs postgres-primary

# Restart database
docker-compose restart postgres-primary

# Wait for initialization
Start-Sleep -Seconds 10
```

### High Memory Usage

```powershell
# Check container stats
docker stats

# Reduce resource limits in docker-compose.yml
# Edit deploy.resources.limits for each service

# Restart services
docker-compose down
docker-compose up -d
```

---

## 6️⃣ Performance Tuning

### Database Optimization

Edit `infrastructure/postgres/postgresql.conf`:

```conf
max_connections = 300
shared_buffers = 512MB
effective_cache_size = 2GB
work_mem = 8MB
maintenance_work_mem = 128MB
```

Restart PostgreSQL:

```powershell
docker-compose restart postgres-primary
```

### Redis Optimization

```powershell
# Increase max memory
docker-compose exec redis-primary redis-cli CONFIG SET maxmemory 4gb

# Optimize eviction
docker-compose exec redis-primary redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Enable persistence
docker-compose exec redis-primary redis-cli CONFIG SET save "900 1 300 10 60 10000"
```

### Nginx Tuning

Edit `infrastructure/nginx/nginx.conf`:

```nginx
worker_processes auto;
worker_connections 8192;
keepalive_timeout 120;
client_max_body_size 20m;
```

Reload:

```powershell
docker-compose exec nginx nginx -s reload
```

---

## 7️⃣ Cleanup

### Stop Services

```powershell
# Stop all services
docker-compose down

# Stop and remove volumes (deletes all data)
docker-compose down -v

# Stop and remove images
docker-compose down --rmi all
```

### Clean Docker System

```powershell
# Remove unused containers
docker container prune -f

# Remove unused images
docker image prune -a -f

# Remove unused volumes
docker volume prune -f

# Remove everything
docker system prune -a -f --volumes
```

---

## 8️⃣ Production Deployment (Kubernetes)

### Prerequisites

- Kubernetes cluster (EKS, GKE, AKS, or local)
- kubectl configured
- Helm (optional)

### Deploy to Kubernetes

```powershell
# Create namespace
kubectl create namespace resultshield

# Apply configurations
kubectl apply -f k8s/ -n resultshield

# Check status
kubectl get pods -n resultshield
kubectl get services -n resultshield

# Access services
kubectl port-forward -n resultshield svc/nginx 8080:80
```

---

## 9️⃣ Cloud Deployment

### AWS (ECS/EKS)

1. **Setup**:
   - Create ECS cluster or EKS cluster
   - Setup RDS PostgreSQL
   - Setup ElastiCache Redis
   - Configure ALB

2. **Deploy**:
   ```bash
   # Build and push images
   docker-compose build
   docker tag resultshield-api-gateway:latest <ecr-url>/api-gateway:latest
   docker push <ecr-url>/api-gateway:latest
   
   # Deploy to ECS
   ecs-cli compose up
   ```

### GCP (GKE)

1. **Setup**:
   - Create GKE cluster
   - Setup Cloud SQL
   - Setup Memorystore Redis
   - Configure Load Balancer

2. **Deploy**:
   ```bash
   # Build and push
   gcloud builds submit --tag gcr.io/<project>/api-gateway
   
   # Deploy to GKE
   kubectl apply -f k8s/
   ```

### Azure (AKS)

1. **Setup**:
   - Create AKS cluster
   - Setup Azure Database for PostgreSQL
   - Setup Azure Cache for Redis
   - Configure Application Gateway

2. **Deploy**:
   ```bash
   # Build and push
   az acr build --registry <registry> --image api-gateway .
   
   # Deploy to AKS
   kubectl apply -f k8s/
   ```

---

## 🔟 Maintenance

### Backup Database

```powershell
# Create backup
docker-compose exec postgres-primary pg_dump -U resultshield resultshield > backup.sql

# Restore backup
docker-compose exec -T postgres-primary psql -U resultshield resultshield < backup.sql
```

### Update Services

```powershell
# Pull latest images
docker-compose pull

# Rebuild services
docker-compose build

# Restart with new images
docker-compose up -d
```

### Monitor Logs

```powershell
# Setup log rotation
# Edit docker-compose.yml and add:
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

---

## 📞 Support

For issues:
1. Check logs: `docker-compose logs`
2. Review documentation in `docs/`
3. Create GitHub issue
4. Email: support@resultshield.com

---

**Deployment guide for production-grade university result system**
