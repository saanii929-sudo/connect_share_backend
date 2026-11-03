#!/usr/bin/env bash
# ConnectShare firewall configuration (iptables + ufw)
# Run on the Linux host that runs the relay server + API.
# Adjust SSH port and trusted CIDRs as needed.

set -euo pipefail

TRUSTED_CIDR="${1:-0.0.0.0/0}"   # restrict to your admin IP

echo "=== ConnectShare Firewall Setup ==="

# ── Reset existing rules ──────────────────────────────────────────────────────
ufw --force reset

# ── Default deny ──────────────────────────────────────────────────────────────
ufw default deny incoming
ufw default allow outgoing

# ── Allow SSH (admin access) ─────────────────────────────────────────────────
ufw allow from "$TRUSTED_CIDR" to any port 22 proto tcp

# ── Allow HTTPS (Caddy reverse proxy) ────────────────────────────────────────
ufw allow 443/tcp
ufw allow 80/tcp       # for Let's Encrypt ACME challenge

# ── Allow WireGuard UDP (creator tunnel endpoint) ─────────────────────────────
ufw allow 51820/udp

# ── Allow relay WebSocket (if not behind Caddy) ───────────────────────────────
# ufw allow 3002/tcp

# ── Internal Docker network (no host exposure needed) ────────────────────────
# PostgreSQL (5432) and Redis (6379) are NOT exposed externally.
# They are only accessible within the Docker network.

# ── Enable ──────────────────────────────────────────────────────────────────
ufw --force enable

echo "=== Firewall configured ==="
echo "Exposed ports: 22 (SSH, restricted), 80/443 (HTTP/HTTPS), 51820/udp (WireGuard)"
echo "Internal-only: 5432 (PostgreSQL), 6379 (Redis), 3000 (API), 3001 (WS), 3002 (Relay)"
