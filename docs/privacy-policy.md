# ConnectShare Privacy Policy

## Data We Collect

### Account data
- **Email address** — used for authentication and account recovery.
- **Full name** — display name for connection participants.
- **Password hash** — stored as Argon2id. Plaintext passwords are never stored or logged.

### Device data
- Device name, platform (Android/iOS/etc), app version.
- Device public key (Ed25519) — used for challenge-response authentication.
- Device fingerprint (SHA-256 of the public key).
- Last active timestamp.

### Connection metadata
- Connection ID, creation time, expiration time, status.
- Creator and participant user/device IDs.
- Approval status and timestamps.
- Tunnel identifiers (opaque, randomly generated).

### Usage statistics
- Total bytes uploaded and downloaded (per connection and per participant).
- Average and current bandwidth.
- Connection duration.
- Latency measurements.

### Audit logs
- All significant actions (registration, login, connection creation, approval,
  tunnel provisioning, termination, revocation) are recorded with timestamps
  and user IDs for security auditing and incident response.

## Data We Do NOT Collect

- **Packet contents** — ConnectShare forwards encrypted packets between the
  relay, creator gateway, and recipient tunnel. The relay does not decrypt or
  inspect application-layer traffic. We cannot see URLs, DNS queries, or
  the content of your internet traffic.
- **Browsing history** — we do not record which websites or services you access.
- **Private cryptographic keys** — WireGuard private keys are encrypted at rest
  (AES-256-GCM) and are never logged. They are returned once to the
  authenticated owner at provisioning time and then never again.
- **Precise location** — we do not collect GPS coordinates. Geographic
  separation is assumed; we do not track it.

## Traffic Visibility

The relay server can observe:
- **Packet sizes and timing** (metadata) — this is inherent to any network
  relay and cannot be avoided while forwarding traffic.
- **Source and destination IP addresses** at the relay layer (the relay's own
  IP and the creator's public IP for egress).

The relay **cannot** observe:
- The content of packets (encrypted end-to-end via WireGuard or the
  WebSocket TLS layer).
- DNS queries (handled by the creator device's resolver).
- Application-layer protocols (HTTP, TLS, etc.) — these are encapsulated.

## Data Retention

| Data type | Retention period |
|---|---|
| Account data | Until account deletion request |
| Device data | Until device revocation |
| Usage statistics | 90 days |
| Audit logs | 1 year |
| Connection events | 90 days |
| Connection records | 90 days after termination |
| Redis session state | TTL-based (expired automatically) |
| Invitation tokens | Until used or revoked, then 30 days |

## Data Subject Rights

Users may request:
- Export of their account and usage data.
- Deletion of their account and all associated data.
- Revocation of all active sessions and devices.
- A list of all connections they have participated in.

Requests should be directed to the platform administrator. Account deletion
marks the user as `DELETED` and purges associated records per the retention
schedule above.

## Security Measures

- All external communications use TLS (HSTS enforced).
- Passwords hashed with Argon2id (OWASP-recommended parameters).
- WireGuard private keys encrypted at rest with AES-256-GCM.
- JWT access tokens are short-lived (15 minutes); refresh tokens rotate on
  each use and are revocable via Redis.
- Invitation tokens are 256-bit random, stored only as SHA-256 hashes.
- Rate limiting on all authentication and join endpoints.
- Replay protection on device authentication (single-use nonces).
- Audit logging of all security-relevant actions.
- No private keys or tokens are logged (pino redaction enforces this).

## Third-Party Data Sharing

ConnectShare does not sell or share user data with third parties. Usage
statistics are used solely for platform operation, billing, and abuse
prevention. Aggregate, anonymized metrics may be used for capacity planning.

## Changes to This Policy

Material changes to this policy will be announced with at least 30 days'
notice. Continued use of the service after the effective date constitutes
acceptance of the updated policy.
