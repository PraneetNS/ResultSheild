import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Custom Metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time_ms');
const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const degradedResponses = new Counter('degraded_responses');
const waitingRoomResponses = new Counter('waiting_room_responses');
const activeVUs = new Gauge('active_virtual_users');

// Test Configuration - 50K Users
export const options = {
    scenarios: {
        load_50k: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '2m', target: 10000 },  // Ramp to 10K
                { duration: '3m', target: 30000 },  // Ramp to 30K
                { duration: '3m', target: 50000 },  // Ramp to 50K
                { duration: '5m', target: 50000 },  // Stay at 50K
                { duration: '2m', target: 0 },      // Ramp down
            ],
            gracefulRampDown: '30s',
        },
    },
    thresholds: {
        'http_req_duration': ['p(95)<2000', 'p(99)<5000'],
        'http_req_failed': ['rate<0.10'],
        'errors': ['rate<0.10'],
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const rollNumbers = Array.from({ length: 10000 }, (_, i) =>
    `2024CS${String(i + 1).padStart(4, '0')}`
);

export default function () {
    activeVUs.add(1);

    const rollNumber = rollNumbers[Math.floor(Math.random() * rollNumbers.length)];
    const requestId = `req-${__VU}-${__ITER}-${Date.now()}`;
    const startTime = Date.now();

    const response = http.get(
        `${BASE_URL}/results/${rollNumber}`,
        {
            headers: {
                'X-User-ID': `user-${__VU}`,
                'X-Request-ID': requestId,
            },
            tags: { name: 'GetResult_50K' },
            timeout: '15s',
        }
    );

    const duration = Date.now() - startTime;
    responseTime.add(duration);

    const success = check(response, {
        'status is 200 or 503': (r) => r.status === 200 || r.status === 503,
        'response time < 5000ms': (r) => r.timings.duration < 5000,
    });

    errorRate.add(!success);

    try {
        const body = JSON.parse(response.body);
        if (body.metadata?.cached) cacheHits.add(1);
        else cacheMisses.add(1);
        if (body.degraded) degradedResponses.add(1);
        if (body.waiting_room || response.status === 503) waitingRoomResponses.add(1);
    } catch (e) { }

    sleep(Math.random() * 3 + 1);
    activeVUs.add(-1);
}

export function handleSummary(data) {
    return {
        'test_results_50k.json': JSON.stringify(data, null, 2),
        stdout: `
╔═══════════════════════════════════════════════════════════════╗
║           ResultShield - Load Test Results (50K Users)        ║
╠═══════════════════════════════════════════════════════════════╣
║ Total Requests:        ${data.metrics.http_reqs.values.count.toFixed(0).padStart(10)}             ║
║ Failed Requests:       ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2).padStart(10)}%            ║
║ Requests/sec:          ${data.metrics.http_reqs.values.rate.toFixed(2).padStart(10)} req/s       ║
║ Response Time (p95):   ${data.metrics.http_req_duration.values['p(95)'].toFixed(2).padStart(10)}ms           ║
║ Response Time (p99):   ${data.metrics.http_req_duration.values['p(99)'].toFixed(2).padStart(10)}ms           ║
╚═══════════════════════════════════════════════════════════════╝
`,
    };
}
