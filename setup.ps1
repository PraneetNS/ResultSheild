# ResultShield - Complete Setup Script for Windows
# This script sets up the entire ResultShield system

Write-Host "🛡️  ResultShield - Production-Grade Result Management System" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Function to print colored output
function Print-Success {
    param($Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Print-Error {
    param($Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Print-Info {
    param($Message)
    Write-Host "ℹ $Message" -ForegroundColor Yellow
}

# Check prerequisites
Write-Host "Checking prerequisites..."

try {
    docker --version | Out-Null
    Print-Success "Docker is installed"
} catch {
    Print-Error "Docker is not installed. Please install Docker Desktop first."
    exit 1
}

$dockerComposeCmd = "docker-compose"
try {
    docker-compose --version | Out-Null
    Print-Success "Docker Compose (v1) is installed"
} catch {
    try {
        docker compose version | Out-Null
        $dockerComposeCmd = "docker compose"
        Print-Success "Docker Compose (v2) is installed"
    } catch {
        Print-Error "Docker Compose is not installed. Please install Docker Desktop first."
        exit 1
    }
}

Write-Host ""

# Create necessary directories
Write-Host "Creating directories..."
New-Item -ItemType Directory -Force -Path logs | Out-Null
New-Item -ItemType Directory -Force -Path data\postgres | Out-Null
New-Item -ItemType Directory -Force -Path data\redis | Out-Null
Print-Success "Directories created"

Write-Host ""

# Copy environment files
Write-Host "Setting up environment files..."
if (-not (Test-Path services\api-gateway\.env)) {
    Copy-Item services\api-gateway\.env.example services\api-gateway\.env
    Print-Success "API Gateway .env created"
} else {
    Print-Info "API Gateway .env already exists"
}

if (-not (Test-Path services\result-service\.env)) {
    Copy-Item services\result-service\.env.example services\result-service\.env
    Print-Success "Result Service .env created"
} else {
    Print-Info "Result Service .env already exists"
}

Write-Host ""

# Start services
Write-Host "Starting services..."
Print-Info "This may take a few minutes..."
docker-compose up -d --build
# Use the dynamic command if possible, but keep it simple for now as it's a shell command
& $dockerComposeCmd up -d --build

Write-Host ""
Write-Host "Waiting for services to initialize..."
Start-Sleep -Seconds 30

# Check service health
Write-Host ""
Write-Host "Checking service health..."

function Check-Service {
    param($ServiceName, $Url)
    
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Print-Success "$ServiceName is healthy"
            return $true
        }
    } catch {
        Print-Error "$ServiceName is not responding"
        return $false
    }
}

Check-Service "Nginx" "http://localhost/health"
Check-Service "Prometheus" "http://localhost:9090/-/healthy"
Check-Service "Grafana" "http://localhost:3001/api/health"
Check-Service "Redis Commander" "http://localhost:8081"

Write-Host ""

# Initialize database
Write-Host "Initializing database..."
Print-Info "Creating tables..."

& $dockerComposeCmd exec -T result-service-1 python -c @"
from app.core.database import init_db
import asyncio
asyncio.run(init_db())
print('Database initialized')
"@

Write-Host ""

# Seed sample data
Write-Host "Seeding sample data..."
Print-Info "Generating 10,000 student records..."

& $dockerComposeCmd exec -T result-service-1 python scripts/seed_data.py 10000

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "🎉 ResultShield setup complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access the following services:"
Write-Host ""
Write-Host "  📊 Grafana Dashboard:    http://localhost:3001 (admin/admin)" -ForegroundColor Cyan
Write-Host "  📈 Prometheus:           http://localhost:9090" -ForegroundColor Cyan
Write-Host "  🔴 Redis Commander:      http://localhost:8081" -ForegroundColor Cyan
Write-Host "  🌐 API Endpoint:         http://localhost/api/v1" -ForegroundColor Cyan
Write-Host "  ✨ Ultimate Portal:      http://localhost/ULTIMATE_PORTAL.html" -ForegroundColor Green
Write-Host ""
Write-Host "Test the API:"
Write-Host "  curl http://localhost/api/v1/results/2024CS0001" -ForegroundColor Yellow
Write-Host ""
Write-Host "Run load tests:"
Write-Host "  k6 run tests/load/spike-test.js" -ForegroundColor Yellow
Write-Host ""
Write-Host "View logs:"
Write-Host "  & $dockerComposeCmd logs -f" -ForegroundColor Yellow
Write-Host ""
Write-Host "Stop services:"
Write-Host "  & $dockerComposeCmd down" -ForegroundColor Yellow
Write-Host ""
Print-Success "Happy testing! 🚀"
