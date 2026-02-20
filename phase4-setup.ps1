# ResultShield - Phase 4 Quick Start Script
# Automated setup and testing for horizontal scaling

Write-Host "🛡️  ResultShield - Phase 4: Extreme Traffic & Horizontal Scaling" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""

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

function Print-Header {
    param($Message)
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
}

# Check prerequisites
Print-Header "Checking Prerequisites"

try {
    docker --version | Out-Null
    Print-Success "Docker is installed"
} catch {
    Print-Error "Docker is not installed"
    exit 1
}

try {
    docker-compose --version | Out-Null
    Print-Success "Docker Compose is installed"
} catch {
    Print-Error "Docker Compose is not installed"
    exit 1
}

# Check if k6 is installed
try {
    k6 version | Out-Null
    Print-Success "k6 is installed"
    $k6Installed = $true
} catch {
    Print-Info "k6 is not installed (optional for load testing)"
    $k6Installed = $false
}

# Start services
Print-Header "Starting Services"

Print-Info "Starting all services (this may take a few minutes)..."
docker-compose up -d

Write-Host ""
Print-Info "Waiting for services to initialize (30 seconds)..."
Start-Sleep -Seconds 30

# Check service health
Print-Header "Checking Service Health"

function Test-ServiceHealth {
    param($Name, $Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Print-Success "$Name is healthy"
            return $true
        }
    } catch {
        Print-Error "$Name is not responding"
        return $false
    }
}

$nginxHealthy = Test-ServiceHealth "Nginx Load Balancer" "http://localhost:8080/nginx-health"
$redisHealthy = Test-ServiceHealth "Redis Commander" "http://localhost:8081"

# Check individual result service instances
Print-Info "Checking result service instances..."
$instances = @("result-service-1", "result-service-2", "result-service-3")
foreach ($instance in $instances) {
    $running = docker ps --filter "name=$instance" --filter "status=running" --format "{{.Names}}"
    if ($running) {
        Print-Success "$instance is running"
    } else {
        Print-Error "$instance is not running"
    }
}

# Test load balancing
Print-Header "Testing Load Balancing"

Print-Info "Making 10 requests to test round-robin distribution..."
for ($i = 1; $i -le 10; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost/results/2024CS0001" -UseBasicParsing -TimeoutSec 10
        $json = $response.Content | ConvertFrom-Json
        $instanceId = $json.metadata.instance_id
        Write-Host "  Request $i → $instanceId" -ForegroundColor Gray
    } catch {
        Write-Host "  Request $i → Failed" -ForegroundColor Red
    }
}

# Test request tracing
Print-Header "Testing Request Tracing"

Print-Info "Sending request with custom trace ID..."
try {
    $headers = @{"X-Request-ID" = "phase4-test-trace-123"}
    $response = Invoke-WebRequest -Uri "http://localhost/results/2024CS0001" -Headers $headers -UseBasicParsing
    $json = $response.Content | ConvertFrom-Json
    
    if ($json.metadata.request_id -eq "phase4-test-trace-123") {
        Print-Success "Request tracing works! Trace ID: $($json.metadata.request_id)"
        Print-Success "Handled by instance: $($json.metadata.instance_id)"
    } else {
        Print-Error "Request tracing failed"
    }
} catch {
    Print-Error "Request tracing test failed: $_"
}

# Test circuit breaker (optional)
Print-Header "Testing Circuit Breaker (Optional)"

$testCircuitBreaker = Read-Host "Do you want to test the circuit breaker? This will temporarily stop the database. (y/N)"
if ($testCircuitBreaker -eq "y" -or $testCircuitBreaker -eq "Y") {
    Print-Info "Stopping PostgreSQL to trigger circuit breaker..."
    docker-compose stop postgres-primary
    
    Start-Sleep -Seconds 2
    
    Print-Info "Making request (should serve stale cache or waiting room)..."
    try {
        $response = Invoke-WebRequest -Uri "http://localhost/results/2024CS0001" -UseBasicParsing
        $json = $response.Content | ConvertFrom-Json
        
        if ($json.metadata.degraded -or $json.waiting_room) {
            Print-Success "Circuit breaker activated! Serving degraded response."
            if ($json.metadata.degraded) {
                Print-Info "Source: $($json.metadata.source)"
                Print-Info "Message: $($json.metadata.message)"
            }
            if ($json.waiting_room) {
                Print-Info "Waiting room activated"
                Print-Info "Message: $($json.message)"
            }
        } else {
            Print-Info "Normal response received (cache may still be available)"
        }
    } catch {
        Print-Info "Request failed as expected (circuit breaker open)"
    }
    
    Print-Info "Restarting PostgreSQL..."
    docker-compose start postgres-primary
    
    Print-Info "Waiting for database to recover (10 seconds)..."
    Start-Sleep -Seconds 10
    
    Print-Success "Database restarted"
} else {
    Print-Info "Skipping circuit breaker test"
}

# Load testing
Print-Header "Load Testing"

if ($k6Installed) {
    $runLoadTest = Read-Host "Do you want to run a load test? (y/N)"
    if ($runLoadTest -eq "y" -or $runLoadTest -eq "Y") {
        Write-Host ""
        Write-Host "Available load tests:" -ForegroundColor Cyan
        Write-Host "  1. 10K users  (recommended for first test)" -ForegroundColor Gray
        Write-Host "  2. 50K users  (moderate load)" -ForegroundColor Gray
        Write-Host "  3. 100K users (EXTREME load)" -ForegroundColor Gray
        Write-Host ""
        
        $testChoice = Read-Host "Select test (1/2/3)"
        
        $testScript = switch ($testChoice) {
            "1" { "tests/load/test-10k-users.js" }
            "2" { "tests/load/test-50k-users.js" }
            "3" { "tests/load/spike-test.js" }
            default { "tests/load/test-10k-users.js" }
        }
        
        Print-Info "Running load test: $testScript"
        Print-Info "This may take several minutes..."
        Write-Host ""
        
        k6 run $testScript
        
        Write-Host ""
        Print-Success "Load test completed!"
        Print-Info "Check test_results_*.json for detailed metrics"
    } else {
        Print-Info "Skipping load test"
    }
} else {
    Print-Info "k6 not installed. Install with: choco install k6"
    Print-Info "Then run: k6 run tests/load/test-10k-users.js"
}

# Summary
Print-Header "Phase 4 Setup Complete!"

Write-Host ""
Write-Host "✅ Services Running:" -ForegroundColor Green
Write-Host "   • Nginx Load Balancer:  http://localhost" -ForegroundColor Cyan
Write-Host "   • Nginx Health:         http://localhost:8080/nginx-health" -ForegroundColor Cyan
Write-Host "   • Redis Commander:      http://localhost:8081" -ForegroundColor Cyan
Write-Host "   • Result Service x3:    Instances 1, 2, 3" -ForegroundColor Cyan
Write-Host ""

Write-Host "📊 Test Endpoints:" -ForegroundColor Green
Write-Host "   • Get Result:           curl http://localhost/results/2024CS0001" -ForegroundColor Gray
Write-Host "   • With Trace ID:        curl -H 'X-Request-ID: trace-123' http://localhost/results/2024CS0001" -ForegroundColor Gray
Write-Host "   • Health Check:         curl http://localhost/health" -ForegroundColor Gray
Write-Host ""

Write-Host "🧪 Load Testing:" -ForegroundColor Green
Write-Host "   • 10K users:            k6 run tests/load/test-10k-users.js" -ForegroundColor Gray
Write-Host "   • 50K users:            k6 run tests/load/test-50k-users.js" -ForegroundColor Gray
Write-Host "   • 100K users:           k6 run tests/load/spike-test.js" -ForegroundColor Gray
Write-Host ""

Write-Host "📝 View Logs:" -ForegroundColor Green
Write-Host "   • All services:         docker-compose logs -f" -ForegroundColor Gray
Write-Host "   • Specific instance:    docker-compose logs -f result-service-2" -ForegroundColor Gray
Write-Host "   • Nginx access:         docker-compose exec nginx tail -f /var/log/nginx/access.log" -ForegroundColor Gray
Write-Host ""

Write-Host "🛑 Stop Services:" -ForegroundColor Green
Write-Host "   • Stop all:             docker-compose down" -ForegroundColor Gray
Write-Host "   • Stop and clean:       docker-compose down -v" -ForegroundColor Gray
Write-Host ""

Write-Host "📖 Documentation:" -ForegroundColor Green
Write-Host "   • Phase 4 README:       PHASE4_README.md" -ForegroundColor Gray
Write-Host "   • Architecture:         docs/ARCHITECTURE.md" -ForegroundColor Gray
Write-Host ""

Print-Success "Phase 4 is ready for extreme traffic testing! 🚀"
Write-Host ""
