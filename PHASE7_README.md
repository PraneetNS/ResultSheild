# ResultShield - Phase 7: Adaptive Rate Limiting & Bot Detection

## 🎯 Phase 7 Goals
✅ Dynamic rate limits based on system load (Queue status)  
✅ IP Risk Scoring and behavior analysis  
✅ Bot detection (Headless agents, high-frequency bursts)  
✅ Automated mitigation (Artificial delays, extreme throttling)  
✅ Real-time telemetry for flagged IPs  

---

## 🏗️ Architecture

### Adaptive Logic
The `adaptiveLimiter` middleware in the API Gateway performs a background sync with the `waiting-room` service every 10 seconds.
- **Healthy**: Queue < 100 → Full capacity (Default: 100 req/min).
- **Strained**: Queue > 100 → 50% capacity.
- **Critical**: Queue > 500 → 10% capacity.

### IP Risk Scoring
Each IP accumulates a "Risk Score" in Redis based on:
1. **Bursts**: > 20 requests in 2 seconds = +10 risk.
2. **User-Agent**: Python/Curl/Missing headers = +5 risk.
3. **Thresholds**:
   - **Score > 50**: Warning level. Reduced rate limit. 500ms delay.
   - **Score > 80**: Critical level. Rate limit set to 1 req/min. 2s delay.
   - **Score > 90**: Immediate 403 Forbidden.

---

## 📊 Monitoring
New panels added to the **Grafana Dashboard**:
- **Adaptive Rate Limit Value**: Current system-wide capacity per IP.
- **Flagged High-Risk IPs**: Real-time count of identified bots.

---

## 🚀 How to Test Bot Detection
1. **Normal User**: Browse normally, risk score stays 0.
2. **Simple Script**:
   ```bash
   for i in {1..30}; do curl http://localhost/api/v1/results/101; done
   ```
   - After ~20 requests, the IP will be flagged.
   - You will see `X-IP-Risk-Score` header increase.
   - Subsequent requests will experience artificial latency (mitigation).
3. **Check Prometheus**: Query `flagged_ips_total`.

## 🔧 Maintenance
To reset a flagged IP manually:
```bash
docker exec -it resultshield-redis-primary redis-cli DEL risk_score:<IP_ADDRESS>
```
