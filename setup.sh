#!/bin/bash

# ResultShield - Complete Setup Script
# This script sets up the entire ResultShield system

set -e

echo "🛡️  ResultShield - Production-Grade Result Management System"
echo "============================================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install Docker first."
    exit 1
fi
print_success "Docker is installed"

if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi
print_success "Docker Compose is installed"

echo ""

# Create necessary directories
echo "Creating directories..."
mkdir -p logs
mkdir -p data/postgres
mkdir -p data/redis
print_success "Directories created"

echo ""

# Copy environment files
echo "Setting up environment files..."
if [ ! -f services/api-gateway/.env ]; then
    cp services/api-gateway/.env.example services/api-gateway/.env
    print_success "API Gateway .env created"
else
    print_info "API Gateway .env already exists"
fi

if [ ! -f services/result-service/.env ]; then
    cp services/result-service/.env.example services/result-service/.env
    print_success "Result Service .env created"
else
    print_info "Result Service .env already exists"
fi

echo ""

# Start services
echo "Starting services..."
print_info "This may take a few minutes..."
docker-compose up -d

echo ""
echo "Waiting for services to initialize..."
sleep 30

# Check service health
echo ""
echo "Checking service health..."

check_service() {
    local service=$1
    local url=$2
    
    if curl -s -f "$url" > /dev/null; then
        print_success "$service is healthy"
        return 0
    else
        print_error "$service is not responding"
        return 1
    fi
}

check_service "Nginx" "http://localhost/health"
check_service "Prometheus" "http://localhost:9090/-/healthy"
check_service "Grafana" "http://localhost:3001/api/health"
check_service "Redis Commander" "http://localhost:8081"

echo ""

# Initialize database
echo "Initializing database..."
print_info "Creating tables and seeding data..."

docker-compose exec -T result-service-1 python -c "
from app.core.database import init_db
import asyncio
asyncio.run(init_db())
print('Database initialized')
" || print_error "Database initialization failed"

echo ""

# Seed sample data
echo "Seeding sample data..."
print_info "Generating 10,000 student records..."

docker-compose exec -T result-service-1 python scripts/seed_data.py 10000 || print_error "Data seeding failed"

echo ""
echo "============================================================"
echo -e "${GREEN}🎉 ResultShield setup complete!${NC}"
echo "============================================================"
echo ""
echo "Access the following services:"
echo ""
echo "  📊 Grafana Dashboard:    http://localhost:3001 (admin/admin)"
echo "  📈 Prometheus:           http://localhost:9090"
echo "  🔴 Redis Commander:      http://localhost:8081"
echo "  🌐 API Endpoint:         http://localhost/api/v1"
echo ""
echo "Test the API:"
echo "  curl http://localhost/api/v1/results/2024CS0001"
echo ""
echo "Run load tests:"
echo "  k6 run tests/load/spike-test.js"
echo ""
echo "View logs:"
echo "  docker-compose logs -f"
echo ""
echo "Stop services:"
echo "  docker-compose down"
echo ""
print_success "Happy testing! 🚀"
