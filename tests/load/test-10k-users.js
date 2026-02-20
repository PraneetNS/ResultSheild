import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// ============================================
// Custom Metrics (Phase 4)
// ============================================
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time_ms');
const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const degradedResponses = new Counter('degraded_responses');
const waitingRoomResponses = new Counter('waiting_room_responses');
const activeVUs = new Gauge('active_virtual_users');

// ============================================
// Test Configuration - 10K Users
// ============================================
export const options = {
    scenarios: {
        load_10k: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '1m', target: 2000 },   // Ramp up to 2K
                { duration: '2m', target: 10000 },  // Ramp up to 10K
                { duration: '3m', target: 10000 },  // Stay at 10K
                { duration: '1m', target: 0 },      // Ramp down
            ],
            gracefulRampDown: '30s',
        },
    },
    thresholds: {
        'http_req_duration': ['p(95)<1000', 'p(99)<2000'], // 95% under 1s
        'http_req_failed': ['rate<0.05'],                   // Error rate < 5%
        'errors': ['rate<0.05'],
        'response_time_ms': ['p(95)<1000'],
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost';

// Sample roll numbers for testing
const rollNumbers = Array.from({ length: 10000 }, (_, i) =>
    `2024CS${String(i + 1).padStart(4, '0')}`
);

export default function () {
    activeVUs.add(1);

    // Select random roll number
    const rollNumber = rollNumbers[Math.floor(Math.random() * rollNumbers.length)];

    // Generate request ID for tracing
    const requestId = `req-${__VU}-${__ITER}-${Date.now()}`;

    const startTime = Date.now();

    // Test: Get single result through Nginx LB
    const response = http.get(
        `${BASE_URL}/results/${rollNumber}`,
        {
            headers: {
                'X-User-ID': `user-${__VU}`,
                'X-Request-ID': requestId,
            },
            tags: { name: 'GetResult' },
            timeout: '10s',
        }
    );

    const duration = Date.now() - startTime;
    responseTime.add(duration);

    // Check response
    const success = check(response, {
        'status is 200 or 503': (r) => r.status === 200 || r.status === 503,
        'response time < 2000ms': (r) => r.timings.duration < 2000,
        'has valid JSON': (r) => {
            try {
                JSON.parse(r.body);
                return true;
            } catch {
                return false;
            }
        },
    });

    // Track metrics
    errorRate.add(!success);

    // Parse response and track specific metrics
    try {
        const body = JSON.parse(response.body);

        // Check if cached
        if (body.metadata && body.metadata.cached) {
            cacheHits.add(1);
        } else {
            cacheMisses.add(1);
        }

        // Check if degraded mode
        if (body.degraded || body.source === 'stale_cache') {
            degradedResponses.add(1);
        }

        // Check if waiting room response
        if (body.waiting_room || response.status === 503) {
            waitingRoomResponses.add(1);
        }

        // Log request tracing info
        if (body.metadata && body.metadata.request_id) {
            console.log(`Request ${requestId} traced as ${body.metadata.request_id}`);
        }
    } catch (e) {
        // Ignore parsing errors
    }

    // Think time - simulate user behavior
    sleep(Math.random() * 2 + 0.5); // 0.5-2.5 seconds

    activeVUs.add(-1);
}

export function handleSummary(data) {
    const summary = {
        'test_results_10k.json': JSON.stringify(data, null, 2),
        stdout: generateTextSummary(data),
    };

    return summary;
}

function generateTextSummary(data) {
    const metrics = data.metrics;

    return `
╔═══════════════════════════════════════════════════════════════╗
║           ResultShield - Load Test Results (10K Users)        ║
╠═══════════════════════════════════════════════════════════════╣
║ Total Requests:        ${metrics.http_reqs.values.count.toFixed(0).padStart(10)} requests     ║
║ Failed Requests:       ${(metrics.http_req_failed.values.rate * 100).toFixed(2).padStart(10)}%            ║
║ Requests/sec:          ${metrics.http_reqs.values.rate.toFixed(2).padStart(10)} req/s       ║
╠═══════════════════════════════════════════════════════════════╣
║ Response Time (avg):   ${metrics.http_req_duration.values.avg.toFixed(2).padStart(10)}ms           ║
║ Response Time (p95):   ${metrics.http_req_duration.values['p(95)'].toFixed(2).padStart(10)}ms           ║
║ Response Time (p99):   ${metrics.http_req_duration.values['p(99)'].toFixed(2).padStart(10)}ms           ║
╠═══════════════════════════════════════════════════════════════╣
║ Cache Hits:            ${metrics.cache_hits ? metrics.cache_hits.values.count.toFixed(0).padStart(10) : '0'.padStart(10)}             ║
║ Cache Misses:          ${metrics.cache_misses ? metrics.cache_misses.values.count.toFixed(0).padStart(10) : '0'.padStart(10)}             ║
║ Cache Hit Ratio:       ${calculateCacheHitRatio(metrics).padStart(10)}%            ║
╠═══════════════════════════════════════════════════════════════╣
║ Degraded Responses:    ${metrics.degraded_responses ? metrics.degraded_responses.values.count.toFixed(0).padStart(10) : '0'.padStart(10)}             ║
║ Waiting Room:          ${metrics.waiting_room_responses ? metrics.waiting_room_responses.values.count.toFixed(0).padStart(10) : '0'.padStart(10)}             ║
╠═══════════════════════════════════════════════════════════════╣
║ VUs (max):             ${metrics.vus_max.values.value.toFixed(0).padStart(10)}             ║
║ Test Duration:         ${(data.state.testRunDurationMs / 1000).toFixed(0).padStart(10)}s            ║
╚═══════════════════════════════════════════════════════════════╝

✅ Test completed successfully!
`;
}

function calculateCacheHitRatio(metrics) {
    if (!metrics.cache_hits || !metrics.cache_misses) return '0.00';

    const hits = metrics.cache_hits.values.count;
    const misses = metrics.cache_misses.values.count;
    const total = hits + misses;

    if (total === 0) return '0.00';

    return ((hits / total) * 100).toFixed(2);
}
