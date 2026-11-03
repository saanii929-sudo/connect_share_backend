# ConnectShare Backend

Remote internet-sharing platform backend. Lets an authenticated user share their existing internet connection with another user via a secure invitation link, regardless of their physical location.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Next.js 16 App (Route Handlers)          :3000          │
│  ┌──────────┐ ┌─────────────┐ ┌────────┐ ┌───────────┐  │
│  │ /api/auth│ │/api/sessions│ │/api/   │ │/api/      │  │
│  │          │ │/api/invites │ │devices │ │tunnel,    │  │
│  │          │ │/api/approvals│ │       │ │usage,     │  │
│  └────┬─────┘ └──────┬──────┘ └───┬────┘ │health,    │  │
│       │              │            │      │metrics    │  │
│  ┌────┴──────────────┴────────────┴────┐ └───────────┘  │
│  │           Service / DAL Layer        │               │
│  │  UserService  SessionService         │               │
│  │  InvitationService  ApprovalService  │               │
│  │  TunnelService  AuditService         │               │
│  └────────────┬──────────────┬──────────┘               │
│               │              │                           │
│          PostgreSQL        Redis                         │
│          (Prisma 7)       (session/rate-limit/pub-sub)   │
└──────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────┐
│  Realtime WebSocket Server                :3001          │
│  (tsx realtime/server.ts)                               │
│  • Auth: { type: "AUTH", token: "<access_token>" }      │
│  • Subscribe: { type: "SUBSCRIBE", topic: "approval:<id>"}│
│  • Redis pub/sub → forward events to subscribed clients │
└─────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────┐
│  Prometheus :9090  →  Grafana :3002                     │
│  Scrapes /api/metrics every 15s                         │
└─────────────────────────────────────────────────────────┘
```

### Internet-Sharing Model

```
Creator's Linux host                         Recipient's device
────────────────────                         ─────────────────
[Physical internet]                          [WireGuard peer]
      │                                             │
   [wg0]  ──── encrypted UDP tunnel ──────────────►│
      │   ← AllowedIPs: 0.0.0.0/0               [wg0]
      │                                          routes all
[MASQUERADE NAT]                              traffic via
(iptables/nft)                               creator's IP
```

**Key point:** ConnectShare coordinates the tunnel. The creator's Linux host must run `wg-quick up` with the config served from `/api/sessions/:id/tunnel`. Actual packet forwarding happens on that host, not in this Next.js process.

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | Next.js 16.4.4 (App Router, Route Handlers) |
| Language | TypeScript 5, ESNext modules |
| ORM | Prisma 7 + `@prisma/adapter-pg` (node-postgres) |
| Database | PostgreSQL 16 |
| Cache / Pub-Sub | Redis 7 (ioredis) |
| Realtime | WebSocket (`ws` library, standalone process) |
| Auth | HS256 JWT (jose), Argon2id passwords (@node-rs/argon2) |
| Tunnel keys | X25519 (Node.js built-in `crypto.generateKeyPairSync`) |
| Private key storage | AES-256-GCM encrypted at rest (HKDF-derived key) |
| Monitoring | Prometheus (prom-client) + Grafana |
| Logging | pino (JSON in prod, pretty in dev) |
| Validation | zod v4 |

---

## Quick Start

### Prerequisites
- Node.js 22+
- Docker + Docker Compose
- (For tunnel data-plane) Linux host with WireGuard installed

### 1. Clone and install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in all REPLACE_ME values:
# openssl rand -base64 32   # run this for each secret
```

### 3. Start infrastructure (Docker)

```bash
# Start postgres + redis + prometheus + grafana
docker compose up -d postgres redis prometheus grafana

# Run Prisma migrations
docker compose run --rm migrate
```

### 4. Run database migrations (local dev without Docker)

```bash
# Ensure DATABASE_URL is set in .env
npm run db:migrate
```

### 5. Start the application

```bash
# Terminal 1: Next.js app
npm run dev

# Terminal 2: WebSocket server
npm run dev:realtime
```

### 6. Full Docker stack

```bash
docker compose up -d
```

Access:
- API: http://localhost:3000
- WebSocket: ws://localhost:3001
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3002 (admin / changeme)

---

## API Reference

All endpoints return `{ data: ... }` on success or `{ error: { code, message } }` on failure.
Authentication: `Authorization: Bearer <access_token>`

### Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account → returns tokens |
| POST | `/api/auth/login` | Login → returns tokens |
| POST | `/api/auth/refresh` | Rotate refresh token |
| POST | `/api/auth/logout` | Revoke refresh token |
| GET  | `/api/auth/me` | Current user profile |

### Devices

| Method | Path | Description |
|---|---|---|
| GET    | `/api/devices` | List my devices |
| POST   | `/api/devices` | Register device (Ed25519 public key) |
| DELETE | `/api/devices/:id` | Revoke device |

### Sessions (Creator)

| Method | Path | Description |
|---|---|---|
| GET    | `/api/sessions` | List my sessions |
| POST   | `/api/sessions` | Create session + generate WG server keypair |
| GET    | `/api/sessions/:id` | Get session details |
| PATCH  | `/api/sessions/:id` | `{ action: "activate" \| "pause" }` |
| DELETE | `/api/sessions/:id` | Revoke session |
| GET    | `/api/sessions/:id/tunnel` | Get wg-quick server `.conf` (text/plain) |
| GET    | `/api/sessions/:id/tunnel/peers` | List peer status + usage |
| POST   | `/api/sessions/:id/usage` | Ingest usage from data-plane agent |
| GET    | `/api/sessions/:id/usage` | Usage stats |

### Invitations

| Method | Path | Description |
|---|---|---|
| GET    | `/api/sessions/:id/invitations` | List invites for session |
| POST   | `/api/sessions/:id/invitations` | Create invite link |
| DELETE | `/api/invitations/:id` | Revoke invite |
| POST   | `/api/invitations/claim` | `{ token }` → creates approval, returns approvalId |

### Approvals

| Method | Path | Description |
|---|---|---|
| GET    | `/api/sessions/:id/approvals` | List pending approvals (creator) |
| GET    | `/api/approvals/:id` | Get approval status (recipient polls this) |
| PATCH  | `/api/approvals/:id` | `{ action: "approve", deviceId }` or `{ action: "reject" \| "revoke" }` |

### System

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness probe (DB + Redis) |
| GET | `/api/metrics` | Prometheus metrics scrape endpoint |

---

## WebSocket Protocol

Connect to `ws://host:3001` and exchange JSON messages.

### Authenticate
```json
{ "type": "AUTH", "token": "<access_token>" }
→ { "type": "AUTH_OK", "userId": "..." }
```

### Subscribe to approval events
```json
{ "type": "SUBSCRIBE", "topic": "approval:<sessionId>" }
→ { "type": "SUBSCRIBED", "topic": "approval:<sessionId>" }
```

### Incoming event example
```json
{
  "channel": "approval:<sessionId>",
  "payload": { "type": "APPROVED", "approvalId": "...", "recipientId": "..." }
}
```

Topics:
- `approval:<sessionId>` — APPROVED / REJECTED / REVOKED events
- `session:<sessionId>` — session lifecycle events
- `monitor` — admin only; aggregated metrics

---

## WireGuard Setup Flow

1. **Creator** calls `POST /api/sessions` with their server `endpoint: "public-ip:51820"`.
2. Session record stores server keypair (private key AES-256-GCM encrypted at rest).
3. Creator calls `PATCH /api/sessions/:id { action: "activate" }`.
4. Creator's host downloads config: `GET /api/sessions/:id/tunnel` → saves as `wg0.conf` → runs `wg-quick up wg0`.
5. **Recipient** uses invite URL `/?t=<token>` to `POST /api/invitations/claim`.
6. Recipient's device WebSocket subscribes to `approval:<sessionId>`.
7. **Creator** sees pending approval, calls `PATCH /api/approvals/:id { action: "approve", deviceId }`.
8. Backend generates a peer keypair, returns `peerConfigText` once to the creator's PATCH response.
9. Creator delivers `peerConfigText` to recipient out-of-band (or API sends via push).
10. Recipient saves the text as `wg0.conf` and runs `wg-quick up wg0`.
11. Tunnel is established. All recipient traffic routes through the creator's IP.

### Usage accounting
The creator's Linux host runs a periodic agent that reads:
```bash
wg show wg0 transfer
```
and POSTs the output to `POST /api/sessions/:id/usage`. The backend updates per-peer bytes and writes `usage_snapshots`.

---

## ⚠️ Linux / Platform Caveats

The following **cannot be tested or validated on Windows** (the development host):

| Feature | Requires |
|---|---|
| `wg-quick up` / `wg-quick down` | Linux + WireGuard kernel module |
| IP forwarding (`net.ipv4.ip_forward=1`) | Linux kernel |
| iptables/nftables MASQUERADE NAT | Linux + root/`NET_ADMIN` capability |
| Docker container with `NET_ADMIN` | Linux Docker host |
| Actual internet traffic forwarding | Linux network stack |

**What IS verified on this Windows build host:**
- ✅ X25519 key generation (32-byte WireGuard keys)
- ✅ AES-256-GCM private key encryption/decryption
- ✅ HMAC invite token sign/verify
- ✅ JWT HS256 sign/verify
- ✅ wg-quick config file assembly (string generation)
- ✅ TypeScript compilation (zero errors)
- ✅ Next.js production build (all 22 routes)
- ✅ Prisma 7 schema validation and client generation

---

## Project Structure

```
.
├── app/
│   ├── api/
│   │   ├── auth/        register, login, refresh, logout, me
│   │   ├── devices/     CRUD, revoke
│   │   ├── sessions/    CRUD, activate, pause, revoke, tunnel, usage
│   │   ├── invitations/ claim, revoke
│   │   ├── approvals/   approve, reject, revoke
│   │   ├── health/      liveness probe
│   │   └── metrics/     Prometheus scrape
│   ├── layout.tsx
│   └── page.tsx
├── generated/
│   └── prisma/          Auto-generated Prisma 7 client
├── lib/
│   ├── auth/            middleware.ts, session.ts
│   ├── config/          env.ts (validated config)
│   ├── crypto/          tokens.ts, password.ts, wireguard.ts
│   ├── services/        user, device, session, invitation,
│   │                    approval, tunnel, audit
│   ├── api-helpers.ts   Response factories, body parsing
│   ├── db.ts            Prisma client singleton
│   ├── errors.ts        AppError hierarchy + mapper
│   ├── logger.ts        pino logger
│   ├── metrics.ts       Prometheus counters/gauges/histograms
│   └── redis.ts         ioredis singleton + key helpers
├── monitoring/
│   ├── prometheus.yml
│   └── grafana/provisioning/
├── prisma/
│   └── schema.prisma    Full schema (8 models, 6 enums)
├── realtime/
│   └── server.ts        Standalone WebSocket + Redis pub/sub server
├── prisma.config.ts     Prisma 7 CLI config
├── instrumentation.ts   Next.js startup hook
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

---

## Security Notes

- Passwords hashed with Argon2id (OWASP recommended parameters)
- WireGuard private keys encrypted at rest (AES-256-GCM, HKDF-derived key)
- Invite tokens: HMAC-SHA256 signed, constant-time verified
- JWT: HS256, short-lived access (15min) + rotating refresh tokens stored in Redis (jti revocation)
- Rate limiting: Redis sliding window on all auth routes
- IDOR protection: every service method re-checks ownership/role
- Audit log: append-only `audit_logs` table for all session/approval/tunnel actions
- Headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options via `next.config.ts`
