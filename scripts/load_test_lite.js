const http = require('http');

const BASE_URL = 'http://localhost/api/v1/results';
const CONCURRENCY = 80;
const DURATION = 300000; // 5 minutes
const START_TIME = Date.now();

const rollNumbers = Array.from({ length: 100 }, (_, i) => `2024CS${String(i + 1).padStart(4, '0')}`);

function makeRequest(id) {
    return new Promise((resolve) => {
        const roll = rollNumbers[Math.floor(Math.random() * rollNumbers.length)];
        const req = http.get(`${BASE_URL}/${roll}`, (res) => {
            res.on('data', () => { });
            res.on('end', () => resolve(true));
        });
        req.on('error', (err) => {
            // console.error(`Worker ${id} Connection Reset`);
            resolve(false);
        });
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function runWorker(id) {
    let requests = 0;
    while (Date.now() - START_TIME < DURATION) {
        await makeRequest(id);
        requests++;
        if (requests % 100 === 0) {
            // console.log(`Worker ${id}: checkpoint ${requests} requests`);
        }
    }
    return requests;
}

console.log(`🚀 Starting Sustained Load Test... Target: ${BASE_URL}`);
console.log(`👥 Workers: ${CONCURRENCY} | Duration: ${DURATION / 1000}s`);

const workers = Array.from({ length: CONCURRENCY }, (_, i) => runWorker(i));

let progressInterval = setInterval(() => {
    const elapsed = (Date.now() - START_TIME) / 1000;
    console.log(`⏱️ Elapsed: ${elapsed.toFixed(0)}s / ${DURATION / 1000}s...`);
}, 15000);

Promise.all(workers).then(results => {
    clearInterval(progressInterval);
    const totalRequests = results.reduce((a, b) => a + b, 0);
    const avgRps = totalRequests / (DURATION / 1000);
    console.log(`\n✅ Load Test Complete!`);
    console.log(`📊 Total Requests: ${totalRequests}`);
    console.log(`📈 Average RPS: ${avgRps.toFixed(2)}`);
});
