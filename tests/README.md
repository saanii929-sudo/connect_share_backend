# ConnectShare Test Suite

## Running tests

```bash
# Unit/integration tests (no DB or Redis needed for crypto-only tests)
npm test

# Watch mode
npm test:watch

# End-to-end networking tests (requires real infrastructure + Android devices)
CONNECTSHARE_E2E=true npm test -- --run tests/e2e
```

## Test categories

| File | Category | Requires DB? | Requires Redis? | Requires hardware? |
|---|---|---|---|---|
| `auth.test.ts` | Authentication (JWT, Argon2) | No | No | No |
| `invitation-security.test.ts` | Invitation token security | No | No | No |
| `wireguard.test.ts` | WireGuard keys + config assembly | No | No | No |
| `relay-frame.test.ts` | Relay binary protocol | No | No | No |
| `bandwidth-accounting.test.ts` | Token bucket + byte accounting | No | No | No |
| `authorization.test.ts` | IDOR / role / ownership checks | No | No | No |
| `e2e/networking.test.ts` | Tunnel + traffic forwarding | Yes | Yes | Android devices |

## What is tested on this build host (Windows)

All non-e2e tests pass on Windows without any external services. They test the
pure crypto/logic layers:
- JWT sign/verify/expire/wrong-secret
- Argon2id hash/verify
- Invitation token generation (256-bit entropy), SHA-256 hashing, uniqueness
- WireGuard X25519 key generation (32-byte correctness)
- AES-256-GCM private key encryption round-trip
- Relay binary frame protocol (build/parse/truncation/magic validation)
- Token bucket bandwidth limiting (burst/exhaust/refill)
- BigInt byte accumulation
- Authorization (owner/admin/IDOR/device ownership)

## What requires real infrastructure

The e2e tests in `tests/e2e/` require:
- Running PostgreSQL + Redis (docker compose up)
- Running relay server (npm run dev:relay)
- At least one Android creator device + one Android recipient device
  (or a Linux host with WireGuard + `wg-quick`)

These validate: actual tunnel establishment, DNS/TCP/UDP through the creator's
connection, bandwidth counters from real network traffic, multi-recipient
concurrency, disconnect/reconnect, and load testing.
