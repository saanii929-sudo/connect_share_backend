# ConnectShare Environment Variables

All variables are defined in `lib/config/env.ts` and validated with Zod at
startup. The application will refuse to start if any required variable is
missing or invalid.

Copy `.env.example` to `.env` and fill in real values. Generate secrets with:
```bash
for i in $(seq 1 8); do openssl rand -base64 32; done
```

---

## Required

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://cs_user:pass@localhost:5432/connectshare` |
| `JWT_ACCESS_SECRET` | HS256 signing key for access JWTs (min 32 chars) | `openssl rand -base64 32` |
| `JWT_REFRESH_SECRET` | HS256 signing key for refresh JWTs (min 32 chars) | `openssl rand -base64 32` |
| `INVITE_HMAC_SECRET` | HMAC key for invitation token signing (min 32 chars) | `openssl rand -base64 32` |
| `DEVICE_TOKEN_SECRET` | HMAC key for device token signing (min 32 chars) | `openssl rand -base64 32` |
| `WG_KEY_ENCRYPTION_SECRET` | Key for AES-256-GCM encryption of WireGuard private keys at rest (min 32 chars) | `openssl rand -base64 32` |
| `RELAY_SESSION_KEY_SECRET` | Key for encrypting relay session keys (min 32 chars) | `openssl rand -base64 32` |

## Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Access token TTL (duration string) |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token TTL |
| `PORT` | `3000` | API server port |
| `REALTIME_PORT` | `3001` | WebSocket hub port |
| `RELAY_PORT` | `3002` | Relay server port (metrics on port+1000) |
| `APP_URL` | `http://localhost:3000` | Public API URL (used in invite links) |
| `WG_SERVER_LISTEN_PORT` | `51820` | Default WireGuard UDP listen port |
| `WG_BASE_SUBNET` | `10.8.0.0/24` | WireGuard address pool |
| `WG_OUTBOUND_IFACE` | `eth0` | Outbound interface for NAT PostUp rules |
| `RELAY_URL` | `ws://localhost:3002` | Relay WebSocket URL (given to gateways) |
| `RELAY_AUTH_SECRET` | _(none)_ | Shared secret for relay→API callbacks. **Set in production.** |
| `GATEWAY_HEARTBEAT_TIMEOUT_MS` | `30000` | Max interval between gateway heartbeats |
| `GATEWAY_VERIFY_ATTEMPTS` | `3` | Probe packets for gateway verification |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `60` | Max requests per window |
| `METRICS_BEARER_TOKEN` | _(none)_ | If set, `/api/metrics` requires this bearer token |
| `CORS_ORIGIN` | `*` | Allowed CORS origin for API routes |

## Docker Compose extras

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `changeme` | PostgreSQL password |
| `GRAFANA_ADMIN_USER` | `admin` | Grafana admin username |
| `GRAFANA_ADMIN_PASSWORD` | `changeme` | Grafana admin password |

## Caddy (TLS)

| Variable | Description |
|---|---|
| `DOMAIN` | Primary domain (e.g. `connectshare.app`) |
| `PROM_USER` | Prometheus basic-auth username |
| `PROM_PASS_BCRYPT` | Prometheus basic-auth password (bcrypt hash) |

---

## Secret rotation

To rotate JWT secrets without logging out all users:
1. Set new values for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`.
2. Deploy. Existing access tokens become invalid immediately; users must
   re-authenticate. Refresh tokens issued with the old secret are rejected.
3. Old Redis refresh-token entries (jti) expire naturally by TTL.

To rotate `WG_KEY_ENCRYPTION_SECRET`:
1. Existing encrypted keys become undecryptable. Connections must be
   re-created (new WireGuard keys generated). Plan a maintenance window.
2. Alternatively, implement a dual-key decryption fallback before rotating.

**Never commit `.env` to git.** The `.gitignore` already excludes it.
