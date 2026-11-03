# ConnectShare Production Deployment Guide

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended) with:
  - Root or sudo access
  - A public IP address
  - Open ports: 80/tcp, 443/tcp, 51820/udp (WireGuard)
  - At least 2 GB RAM, 2 vCPU
- A registered domain with DNS A records pointing to the server:
  - `connectshare.app` → server IP
  - `ws.connectshare.app` → server IP
  - `relay.connectshare.app` → server IP
  - (optional) `grafana.connectshare.app`, `prometheus.connectshare.app`
- Docker + Docker Compose installed

---

## 1. Clone and configure

```bash
git clone <your-repo> /opt/connectshare
cd /opt/connectshare

# Copy and edit environment
cp .env.example .env
# Edit .env — generate secrets with:
#   for i in $(seq 1 7); do openssl rand -base64 32; done
```

Fill in all `REPLACE_ME` values in `.env`. Set `DOMAIN=connectshare.app`.

---

## 2. Configure the firewall

```bash
chmod +x docker/firewall.sh
sudo ./docker/firewall.sh <your-admin-cidr>
```

This allows SSH (restricted), HTTP/HTTPS, and WireGuard UDP 51820. PostgreSQL
and Redis are never exposed externally — they live in the Docker network.

---

## 3. Start the stack

```bash
# Start infrastructure first
docker compose up -d postgres redis

# Run database migrations
docker compose run --rm migrate

# Start the application services
docker compose up -d app realtime relay

# Start monitoring
docker compose up -d prometheus grafana
```

---

## 4. TLS configuration (Caddy)

Caddy provides automatic Let's Encrypt TLS termination.

```bash
# Create a Caddy container (or install Caddy on the host)
docker run -d \
  --name caddy \
  --restart unless-stopped \
  -p 80:80 -p 443:443 \
  -v /opt/connectshare/docker/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data \
  -v caddy_config:/config \
  -e DOMAIN=connectshare.app \
  --network connectshare_default \
  caddy:2.8
```

Caddy will automatically provision certificates for all subdomains on first
request. Verify TLS is working:

```bash
curl -I https://connectshare.app/api/health
# Should return 200 with HSTS header
```

---

## 5. Linux relay server setup (WireGuard)

If using WireGuard kernel mode (for Linux-host creators), set up the WireGuard
interface on the server:

```bash
sudo apt install wireguard wireguard-tools

# Enable IP forwarding (required for NAT)
sudo sysctl -w net.ipv4.ip_forward=1
sudo sysctl -w net.ipv6.conf.all.forwarding=1
# Persist:
echo 'net.ipv4.ip_forward=1' | sudo tee -a /etc/sysctl.d/99-connectshare.conf
echo 'net.ipv6.conf.all.forwarding=1' | sudo tee -a /etc/sysctl.d/99-connectshare.conf
```

The actual `wg0.conf` for each connection is generated dynamically by the API
(`GET /api/v1/connections/:id` → `GET /api/v1/network/gateway/register`).
The creator's agent downloads it, saves it to `/etc/wireguard/wg0.conf`, and
runs `wg-quick up wg0`.

For Android creators (no root), the relay WebSocket proxy mode is used instead
— see `docs/android-networking.md`.

---

## 6. Database migrations

```bash
# Apply migrations to production
docker compose run --rm migrate

# To create a new migration after schema changes:
# (run on a dev machine with DB access)
npx prisma migrate dev --name <descriptive_name>
```

---

## 7. Monitoring and alerting

- **Prometheus** scrapes `/api/metrics` (app) and the relay metrics endpoint
  every 15s. Alert rules are in `monitoring/alerts.yml`.
- **Grafana** auto-provisions the datasource and dashboard from
  `monitoring/grafana/provisioning/`.
- Access Grafana at `https://grafana.connectshare.app` (admin / your password).

Configure alertmanager or notification channels (Slack, email, PagerDuty) in
Grafana or Prometheus for the alerts defined in `alerts.yml`.

---

## 8. Environment variables

See `docs/environment-variables.md` for the complete reference.

---

## 9. Verification checklist

After deployment, verify:

```bash
# API health
curl https://connectshare.app/api/health
# → {"status":"ok","checks":{"database":"ok","redis":"ok"}}

# Metrics exposed
curl -H "Authorization: Bearer $METRICS_BEARER_TOKEN" https://connectshare.app/api/metrics
# → Prometheus format metrics

# Relay is reachable
curl https://relay.connectshare.app/
# → relay info (or 426 Upgrade Required if no WS upgrade)

# WebSocket hub is reachable
# (use wscat: npx wscat -c wss://ws.connectshare.app)

# Prometheus targets are up
curl https://prometheus.connectshare.app/api/v1/targets
```

---

## 10. Scaling

### Horizontal API scaling
The API is stateless — all session state lives in Redis. Scale by adding more
`app` containers behind the load balancer:

```bash
docker compose up -d --scale app=3
```

### Relay scaling
The relay holds per-connection gateway/tunnel maps in memory. To scale:
1. Use consistent hashing by connectionId to route WebSocket connections to
   specific relay instances (configure in the load balancer).
2. Or run multiple relay instances and assign connections round-robin, storing
   the relay node ID in `connection.relayNodeId`.

### Database
Use connection pooling (PgBouncer) if you exceed ~100 concurrent API instances.

---

## 11. Backup

```bash
# PostgreSQL backup
docker compose exec postgres pg_dump -U cs_user connectshare | gzip > backup_$(date +%F).sql.gz

# Restore
gunzip < backup_YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U cs_user connectshare

# Redis: RDB snapshots are automatic (appendonly + save rules in redis.conf)
```
