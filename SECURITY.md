# Security Policy

## Reporting a Vulnerability

We take the security of ResultShield seriously. If you believe you have found a security vulnerability, please report it to us by emailing security@resultshield.com.

## Security Features Implemented

The following security measures are active in the production configuration:

### 1. Robust Signature Validation
- **Strict Algorithm Enforcement**: All JWTs (Waiting Room tokens) are strictly verified using `HS256` only.
- **Issuer Validation**: Tokens must match the trusted issuer `resultshield-waiting-room`.
- **Clock-Skew Protection**: Verification includes a 10-second buffer for clock synchronization issues across microservices.

### 2. Traffic & Replay Protection
- **Correlation IDs**: All requests are tagged with `X-Correlation-ID`. This provides an audit trail across the entire microservice mesh.
- **Nonce/JTI**: Waiting room tokens contain a unique `jti` to prevent replay attacks.
- **Rate Limiting**: Multi-layered rate limiting (IP-based and Adaptive) prevents brute-force and DDoS.

### 3. Header Security
- **Helmet.js**: Standardized security headers (CSP, HSTS, X-Frame-Options, etc.) are applied to all Express-based gateways.
- **HSTS**: High-security transport protection is enabled for a 1-year duration in production.

### 4. Input Sanitization
- **Strict Schema Validation**: `express-validator` is used to sanitize and validate all public-facing parameters (roll numbers, batch lists, etc.).
- **Payload Limits**: Request body sizes are strictly limited (1MB) to prevent memory exhaustion attacks.

### 5. Data Isolation & Safety
- **Database Timeouts**: No database query is allowed to run indefinitely. Strict timeouts are enforced at the app level.
- **Redis TTL**: Every temporary key in Redis has a Time-To-Live (TTL) to prevent memory-leakage attacks or cache poisoning.
- **NullPool/QueuePool**: Connection pools are strictly limited to prevent exhaustion of upstream resources.

## Deployment Checklist (Production)

- [ ] Ensure `JWT_SECRET` is changed from defaults.
- [ ] Set `NODE_ENV=production` in all services.
- [ ] Configure `ALLOWED_ORIGINS` to specific domains, not `*`.
- [ ] Use a reverse proxy (like Nginx) for SSL/TLS termination.
- [ ] Enable `ENABLE_ADAPTIVE_LIMITING` for intelligent surge protection.
