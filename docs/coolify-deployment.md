# Coolify Deployment Guide

## Architecture on Coolify

```
Coolify (Traefik proxy — TLS automatic)
   │
   ├── app          → https://api.yourdomain.com        (Next.js API)
   ├── realtime     → wss://ws.yourdomain.com            (WebSocket hub)
   ├── relay        → wss://relay.yourdomain.com         (Networking engine)
   ├── grafana      → https://grafana.yourdomain.com     (Monitoring)
   ├── postgres     → internal only
   └── redis        → internal only
```

Coolify handles TLS (Let's Encrypt), the Traefik reverse proxy, and container
orchestration. You do **not** need Caddy or a separate proxy.

---

## Step 1 — Prepare your Git repository

Push the project to GitHub (or GitLab). Make sure these files are committed:
- `docker-compose.coolify.yml`
- `Dockerfile`
- `prisma/schema.prisma`
- `monitoring/` folder
- `.github/workflows/coolify.yml`

The `.env` file is **never** committed — secrets go into Coolify's UI.

---

## Step 2 — Add the application in Coolify

1. In Coolify → **New Resource** → **Docker Compose**
2. Connect your Git repository
3. Set **Docker Compose Location** to `docker-compose.coolify.yml`
4. Leave the build pack as **Docker Compose**

---

## Step 3 — Set environment variables in Coolify

Go to the resource → **Environment Variables** tab. Add every variable below.

### Generate the secrets first (run once on any machine):
```bash
for i in $(seq 1 7); do openssl rand -base64 32; done
```

### Required variables

| Variable | Description |
|---|---|
| `GITHUB_REPOSITORY` | Your repo path e.g. `yourname/connect_share_backend` |
| `IMAGE_TAG` | `latest` (or a specific SHA for pinned deploys) |
| `POSTGRES_PASSWORD` | Strong password for PostgreSQL |
| `JWT_ACCESS_SECRET` | Min 32 chars (openssl rand -base64 32) |
| `JWT_REFRESH_SECRET` | Min 32 chars |
| `INVITE_HMAC_SECRET` | Min 32 chars |
| `DEVICE_TOKEN_SECRET` | Min 32 chars |
| `WG_KEY_ENCRYPTION_SECRET` | Min 32 chars |
| `RELAY_SESSION_KEY_SECRET` | Min 32 chars |
| `RELAY_AUTH_SECRET` | Min 32 chars |
| `GRAFANA_ADMIN_PASSWORD` | Strong password for Grafana UI |
| `METRICS_BEARER_TOKEN` | Token to protect /api/metrics (any strong random string) |

### Domain variables (Coolify routing)

| Variable | Example value |
|---|---|
| `SERVICE_FQDN_APP` | `api.yourdomain.com` |
| `SERVICE_FQDN_REALTIME` | `ws.yourdomain.com` |
| `SERVICE_FQDN_RELAY` | `relay.yourdomain.com` |
| `SERVICE_FQDN_GRAFANA` | `grafana.yourdomain.com` |

### Optional (sensible defaults)

| Variable | Default | Description |
|---|---|---|
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token lifetime |
| `WG_SERVER_LISTEN_PORT` | `51820` | WireGuard UDP port |
| `WG_BASE_SUBNET` | `10.8.0.0/24` | Tunnel IP pool |
| `WG_OUTBOUND_IFACE` | `eth0` | NAT outbound interface |
| `GATEWAY_HEARTBEAT_TIMEOUT_MS` | `30000` | Gateway keep-alive timeout |
| `GATEWAY_VERIFY_ATTEMPTS` | `3` | Probe count for gateway verify |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `60` | Max requests per window |
| `GRAFANA_ADMIN_USER` | `admin` | Grafana admin username |

---

## Step 4 — Assign domains to services in Coolify

After adding the environment variables, go to the **Domains** tab for each service:

| Service | Port | Domain variable |
|---|---|---|
| `app` | 3000 | `SERVICE_FQDN_APP` |
| `realtime` | 3001 | `SERVICE_FQDN_REALTIME` |
| `relay` | 3002 | `SERVICE_FQDN_RELAY` |
| `grafana` | 3000 | `SERVICE_FQDN_GRAFANA` |

Coolify's Traefik proxy will terminate TLS automatically via Let's Encrypt.

---

## Step 5 — Set up GitHub Actions (CI/CD)

The workflow at `.github/workflows/coolify.yml` builds and pushes the Docker
image to GHCR, then triggers Coolify's deploy webhook.

### Add repository secrets in GitHub

Go to your repo → **Settings** → **Secrets and variables** → **Actions**:

| Secret | Where to get it |
|---|---|
| `COOLIFY_WEBHOOK` | Coolify → resource → **Webhooks** → copy Deploy webhook URL |
| `COOLIFY_TOKEN` | Coolify → **Keys & Tokens** → **API Tokens** → create with Deploy permission |

### First deploy

For the first deploy (before GitHub Actions has run), trigger manually:
1. Go to Coolify → your resource → **Deploy**
2. This builds using the `build:` context in the Dockerfile directly

After the first deploy, every push to `main` will:
1. Build the image in GitHub Actions
2. Push to `ghcr.io/<yourname>/connect_share_backend/app:latest`
3. Trigger Coolify to pull the new image and restart containers

---

## Step 6 — WireGuard / Relay (firewall rules)

On the Coolify server, open UDP port 51820 for WireGuard:

```bash
# If using ufw:
ufw allow 51820/udp
ufw allow 3002/tcp   # relay WebSocket (if not proxied through Traefik)
```

The relay WebSocket should be routed through Traefik (wss://) for TLS.
If you expose it directly on 3002, ensure TLS is handled at the server level.

---

## Step 7 — Database migration

The `migrate` service in `docker-compose.coolify.yml` runs `prisma migrate deploy`
automatically before the `app` service starts (via `depends_on: migrate`).

For the very first deploy, or after schema changes, no manual intervention
is needed — Coolify runs the migrate container on every deploy.

---

## Step 8 — Verify the deployment

Once deployed:

```bash
# API health check
curl https://api.yourdomain.com/api/health
# → {"status":"ok","checks":{"database":"ok","redis":"ok"}}

# API docs
open https://api.yourdomain.com/api-docs

# Metrics
curl -H "Authorization: Bearer <METRICS_BEARER_TOKEN>" \
  https://api.yourdomain.com/api/metrics

# Grafana
open https://grafana.yourdomain.com
```

---

## Troubleshooting

**`migrate` service fails to start**
→ PostgreSQL health check hasn't passed yet. Wait 30s and redeploy.

**`app` service exits with env validation error**
→ A required env var is missing. Check Coolify's environment variables tab.

**Redis ECONNREFUSED logs**
→ Redis container isn't healthy yet. The app retries with exponential back-off;
   it will recover automatically once Redis starts.

**Image pull fails (403)**
→ The GHCR image is private. In Coolify → Server → Registries, add a GitHub
   token with `read:packages` scope.

**WebSocket connection refused**
→ Ensure `realtime` and `relay` services have domains assigned in Coolify
   with the correct ports (3001 and 3002).
