/**
 * GET /api-docs
 * Interactive HTML API reference — self-contained, no external dependencies.
 */
import { getConfig } from '@/lib/config/env'

interface Endpoint {
  method:      'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'
  path:        string
  description: string
  auth:        boolean
  body?:       string   // JSON example
  response?:   string  // JSON example
  internal?:   boolean
}

interface Category {
  name:      string
  endpoints: Endpoint[]
}

const CATEGORIES: Category[] = [
  {
    name: 'Authentication',
    endpoints: [
      {
        method: 'POST', path: '/api/v1/auth/register', auth: false,
        description: 'Create a new user account. Returns user profile + JWT tokens.',
        body: `{ "fullName": "Jane Doe", "email": "jane@example.com", "password": "SecureP@ss1" }`,
        response: `{ "data": { "user": { "id": "clx...", "fullName": "Jane Doe", "email": "jane@example.com", "role": "USER" }, "tokens": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "expiresIn": 900 } } }`,
      },
      {
        method: 'POST', path: '/api/v1/auth/login', auth: false,
        description: 'Authenticate with email + password. Returns tokens.',
        body: `{ "email": "jane@example.com", "password": "SecureP@ss1" }`,
        response: `{ "data": { "user": { ... }, "tokens": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "expiresIn": 900 } } }`,
      },
      {
        method: 'POST', path: '/api/v1/auth/refresh', auth: false,
        description: 'Rotate a refresh token for a new access + refresh pair. Old token is revoked (one-time use).',
        body: `{ "refreshToken": "eyJ..." }`,
        response: `{ "data": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "expiresIn": 900 } }`,
      },
      {
        method: 'POST', path: '/api/v1/auth/logout', auth: false,
        description: 'Revoke the provided refresh token.',
        body: `{ "refreshToken": "eyJ..." }`,
        response: `204 No Content`,
      },
    ],
  },
  {
    name: 'Devices',
    endpoints: [
      {
        method: 'POST', path: '/api/v1/devices/register', auth: true,
        description: 'Register a new device. Stores Ed25519 public key; derives SHA-256 fingerprint. Returns a short-lived device token.',
        body: `{ "deviceName": "Pixel 8", "platform": "ANDROID", "appVersion": "1.0.0", "publicKey": "base64-ed25519-pubkey..." }`,
        response: `{ "data": { "device": { "id": "clx...", "deviceName": "Pixel 8", "platform": "ANDROID", "fingerprint": "a1b2..." }, "deviceToken": "signed-token" } }`,
      },
      {
        method: 'GET', path: '/api/v1/devices', auth: true,
        description: 'List all devices belonging to the authenticated user.',
        response: `{ "data": [ { "id": "clx...", "deviceName": "Pixel 8", "platform": "ANDROID", "deviceStatus": "ACTIVE", ... } ] }`,
      },
      {
        method: 'DELETE', path: '/api/v1/devices/:deviceId', auth: true,
        description: 'Revoke a device. Invalidates its device token in Redis.',
        response: `204 No Content`,
      },
      {
        method: 'POST', path: '/api/v1/devices/challenge', auth: true,
        description: 'Issue a challenge nonce for device authentication (replay-protected, single-use).',
        body: `{ "deviceId": "clx..." }`,
        response: `{ "data": { "deviceId": "clx...", "nonce": "base64url-nonce", "algorithm": "Ed25519" } }`,
      },
      {
        method: 'POST', path: '/api/v1/devices/verify', auth: true,
        description: 'Verify a device challenge-response signature. Consumes the nonce (single-use). Issues a device token.',
        body: `{ "deviceId": "clx...", "nonce": "base64url-nonce", "signature": "base64-ed25519-sig" }`,
        response: `{ "data": { "verified": true, "deviceToken": "signed-token", "expiresIn": 3600 } }`,
      },
    ],
  },
  {
    name: 'Connections (Creator)',
    endpoints: [
      {
        method: 'POST', path: '/api/v1/connections/create', auth: true,
        description: 'Create a new internet-sharing connection. Provisions WireGuard server keys. Returns connectionId + expiresAt.',
        body: `{ "creatorDeviceId": "clx...", "title": "Home WiFi", "maxRecipients": 5, "expiresIn": 3600, "endpoint": "203.0.113.5:51820", "maxBytesTotal": 1073741824, "bandwidthLimitBps": 5000000 }`,
        response: `{ "data": { "id": "clx...", "creatorUserId": "clx...", "sessionStatus": "PENDING", "gatewayStatus": "DISCONNECTED", "maxRecipients": 5, "expiresAt": "2026-11-03T...", "createdAt": "2026-11-03T..." } }`,
      },
      {
        method: 'GET', path: '/api/v1/connections/:connectionId', auth: true,
        description: 'Get connection details. Visible to creator or approved participants.',
        response: `{ "data": { "id": "clx...", "sessionStatus": "ACTIVE", "gatewayStatus": "VERIFIED", ... } }`,
      },
      {
        method: 'POST', path: '/api/v1/connections/:connectionId/stop', auth: true,
        description: 'Creator terminates the connection. All tunnels and gateways are immediately revoked.',
        response: `{ "data": { "id": "clx...", "sessionStatus": "TERMINATED", "disconnectedAt": "2026-11-03T..." } }`,
      },
      {
        method: 'GET', path: '/api/v1/connections/history', auth: true,
        description: 'List ended connections (terminated or expired) where the user was creator or participant.',
        response: `{ "data": [ { "id": "clx...", "sessionStatus": "TERMINATED", ... } ] }`,
      },
    ],
  },
  {
    name: 'Invitations',
    endpoints: [
      {
        method: 'POST', path: '/api/v1/connections/:connectionId/invitations', auth: true,
        description: 'Create a secure invitation link. Token is 256-bit random; only the SHA-256 hash is stored. Raw token returned once.',
        body: `{ "maxUses": 1, "expiresIn": 3600 }`,
        response: `{ "data": { "id": "clx...", "inviteUrl": "http://localhost:3000/join/aBcDeF...", "tokenHash": "sha256-hex", "status": "PENDING", "maxUses": 1, "currentUses": 0, "expiresAt": "2026-11-03T..." } }`,
      },
      {
        method: 'GET', path: '/api/v1/connections/:connectionId/invitations', auth: true,
        description: 'List invitations for a connection (creator only). Raw tokens are NOT included.',
        response: `{ "data": [ { "id": "clx...", "tokenHash": "sha256-hex", "status": "PENDING", ... } ] }`,
      },
      {
        method: 'POST', path: '/api/v1/invitations/validate', auth: false,
        description: 'Validate an invitation token without claiming it. Returns connection metadata for the recipient.',
        body: `{ "token": "aBcDeF..." }`,
        response: `{ "data": { "valid": true, "connectionId": "clx...", "connection": { "title": "Home WiFi", "sessionStatus": "READY", "creator": { "fullName": "Jane" } } } }`,
      },
      {
        method: 'POST', path: '/api/v1/invitations/:invitationId/revoke', auth: true,
        description: 'Revoke an invitation link (creator only).',
        response: `204 No Content`,
      },
    ],
  },
  {
    name: 'Joining (Recipient)',
    endpoints: [
      {
        method: 'POST', path: '/api/v1/connections/join', auth: true,
        description: 'Recipient submits an invitation token to join a connection. Creates a pending participant record and notifies the creator in real-time.',
        body: `{ "token": "aBcDeF...", "deviceId": "clx..." }`,
        response: `{ "data": { "participantId": "clx...", "connectionId": "clx...", "message": "Join request submitted — awaiting creator approval" } }`,
      },
      {
        method: 'POST', path: '/api/v1/connections/:connectionId/approve', auth: true,
        description: 'Creator approves a pending participant. Automatically provisions a tunnel session and returns the peer WireGuard config (private key shown ONCE).',
        body: `{ "participantId": "clx..." }`,
        response: `{ "data": { "participant": { "id": "clx...", "approvalStatus": "APPROVED", ... }, "tunnel": { "tunnelId": "clx...", "peerConfig": "[Interface]\\nPrivateKey = ...\\nAddress = 10.8.0.2/32\\n...", "tunnelToken": "signed-tunnel-token" } } }`,
      },
      {
        method: 'POST', path: '/api/v1/connections/:connectionId/reject', auth: true,
        description: 'Creator rejects a pending participant.',
        body: `{ "participantId": "clx...", "reason": "Unknown user" }`,
        response: `{ "data": { "id": "clx...", "approvalStatus": "REJECTED", ... } }`,
      },
      {
        method: 'POST', path: '/api/v1/connections/:connectionId/leave', auth: true,
        description: 'Recipient voluntarily leaves a connection.',
        body: `{ "participantId": "clx..." }`,
        response: `204 No Content`,
      },
    ],
  },
  {
    name: 'Statistics',
    endpoints: [
      {
        method: 'GET', path: '/api/v1/connections/:connectionId/statistics', auth: true,
        description: 'Get usage statistics for a connection. Includes total bytes, per-participant breakdown, average bandwidth, and latency.',
        response: `{ "data": { "connectionId": "clx...", "totalBytesUploaded": "1048576", "totalBytesDownloaded": "5242880", "avgDownloadSpeedBps": 500000, "avgLatencyMs": 45, "participantStats": [ ... ] } }`,
      },
      {
        method: 'GET', path: '/api/v1/users/me/usage', auth: true,
        description: 'Aggregate usage across all connections for the authenticated user.',
        response: `{ "data": { "totalBytesUploaded": "10485760", "totalBytesDownloaded": "52428800", "connectionCount": 12 } }`,
      },
    ],
  },
  {
    name: 'Networking (Gateway & Tunnel)',
    endpoints: [
      {
        method: 'POST', path: '/api/v1/network/gateway/register', auth: true,
        description: 'Creator registers its gateway with the relay. Returns a short-lived gateway JWT, the WireGuard server config (wg-quick .conf), and the relay WebSocket URL.',
        body: `{ "connectionId": "clx...", "creatorDeviceId": "clx..." }`,
        response: `{ "data": { "gatewayToken": "eyJ...", "serverConfig": "[Interface]\\nPrivateKey = ...\\nAddress = 10.8.0.1/24\\n...", "relayUrl": "ws://localhost:3002" } }`,
      },
      {
        method: 'POST', path: '/api/v1/network/gateway/heartbeat', auth: true,
        description: 'Creator agent calls this every ~15s to keep the gateway alive. Refreshes Redis TTL. Optionally reports usage.',
        body: `{ "connectionId": "clx...", "bytesRx": 5242880, "bytesTx": 1048576, "latencyMs": 45 }`,
        response: `{ "data": { "status": "ACTIVE", "gatewayStatus": "VERIFIED" } }`,
      },
      {
        method: 'POST', path: '/api/v1/network/gateway/verify', auth: false, internal: true,
        description: 'Internal: relay calls this after gateway verification succeeds. Transitions connection to READY. Protected by RELAY_AUTH_SECRET.',
        body: `{ "connectionId": "clx..." }`,
        response: `204 No Content`,
      },
      {
        method: 'POST', path: '/api/v1/network/tunnel/establish', auth: false, internal: true,
        description: 'Internal: relay calls this when a recipient tunnel passes verification. Marks tunnel ACTIVE and activates routing. Protected by RELAY_AUTH_SECRET.',
        body: `{ "tunnelIdentifier": "base64url-identifier" }`,
        response: `204 No Content`,
      },
      {
        method: 'POST', path: '/api/v1/network/tunnel/terminate', auth: true,
        description: 'Terminate a specific tunnel session. Creator or the participant themselves may call this.',
        body: `{ "tunnelId": "clx..." }`,
        response: `204 No Content`,
      },
      {
        method: 'GET', path: '/api/v1/network/tunnel/:tunnelId/status', auth: true,
        description: 'Get the status of a specific tunnel session.',
        response: `{ "data": { "tunnelId": "clx...", "tunnelIdentifier": "base64url...", "tunnelStatus": "ACTIVE", "lastHandshakeAt": "2026-11-03T...", "createdAt": "2026-11-03T..." } }`,
      },
    ],
  },
  {
    name: 'System',
    endpoints: [
      {
        method: 'GET', path: '/api/health', auth: false,
        description: 'Liveness probe. Checks PostgreSQL and Redis connectivity.',
        response: `{ "status": "ok", "checks": { "database": "ok", "redis": "ok" }, "ts": "2026-11-03T..." }`,
      },
      {
        method: 'GET', path: '/api/metrics', auth: false,
        description: 'Prometheus metrics scrape endpoint. Optionally protected by METRICS_BEARER_TOKEN.',
        response: `# Prometheus exposition format\\n# HELP cs_sessions_active ...\\ncs_sessions_active 3\\n...`,
      },
    ],
  },
]

function methodColor(method: string): string {
  const colors: Record<string, string> = {
    GET:    '#2e7d32',
    POST:   '#1565c0',
    DELETE: '#c62828',
    PATCH:  '#ef6c00',
    PUT:    '#6a1b9a',
  }
  return colors[method] ?? '#666'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function GET() {
  let appUrl = 'http://localhost:3000'
  try {
    const cfg = getConfig()
    appUrl = cfg.APP_URL
  } catch { /* env not configured — use default */ }

  const categoriesHtml = CATEGORIES.map(cat => `
    <section class="category">
      <h2>${escapeHtml(cat.name)}</h2>
      ${cat.endpoints.map(ep => `
        <div class="endpoint ${ep.internal ? 'internal' : ''}">
          <div class="endpoint-header">
            <span class="method" style="background:${methodColor(ep.method)}">${ep.method}</span>
            <code class="path">${escapeHtml(ep.path)}</code>
            ${ep.auth ? '<span class="badge auth">Auth</span>' : '<span class="badge public">Public</span>'}
            ${ep.internal ? '<span class="badge internal">Internal</span>' : ''}
          </div>
          <p class="desc">${escapeHtml(ep.description)}</p>
          ${ep.body ? `
            <div class="block">
              <span class="label">Request Body</span>
              <pre><code>${escapeHtml(ep.body)}</code></pre>
            </div>` : ''}
          ${ep.response ? `
            <div class="block">
              <span class="label">Response</span>
              <pre><code>${escapeHtml(ep.response)}</code></pre>
            </div>` : ''}
        </div>
      `).join('')}
    </section>
  `).join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ConnectShare API Reference</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e0e0e0; line-height: 1.6; }
    .header { background: #161922; border-bottom: 1px solid #2a2d3a; padding: 2rem 2rem 1.5rem; position: sticky; top: 0; z-index: 10; }
    .header h1 { font-size: 1.5rem; color: #fff; margin-bottom: 0.25rem; }
    .header p { color: #888; font-size: 0.875rem; }
    .header .base-url { margin-top: 0.75rem; font-family: 'SF Mono', Monaco, monospace; font-size: 0.8rem; color: #56b6c2; background: #1c1f2b; padding: 0.4rem 0.75rem; border-radius: 4px; display: inline-block; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    .category { margin-bottom: 2.5rem; }
    .category h2 { font-size: 1.1rem; color: #61afef; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #2a2d3a; text-transform: uppercase; letter-spacing: 0.05em; }
    .endpoint { background: #161922; border: 1px solid #2a2d3a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
    .endpoint.internal { opacity: 0.7; border-style: dashed; }
    .endpoint-header { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .method { font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 4px; color: #fff; letter-spacing: 0.05em; }
    .path { font-family: 'SF Mono', Monaco, monospace; font-size: 0.875rem; color: #abb2bf; flex: 1; word-break: break-all; }
    .badge { font-size: 0.65rem; padding: 0.15rem 0.5rem; border-radius: 3px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge.auth { background: #2d4a3e; color: #98c379; }
    .badge.public { background: #3a3530; color: #e5c07b; }
    .badge.internal { background: #4a2d2d; color: #e06c75; }
    .desc { color: #999; font-size: 0.85rem; margin-bottom: 0.75rem; }
    .block { margin-top: 0.75rem; }
    .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; display: block; margin-bottom: 0.25rem; }
    pre { background: #0d0f14; border: 1px solid #2a2d3a; border-radius: 6px; padding: 0.75rem; overflow-x: auto; }
    code { font-family: 'SF Mono', Monaco, monospace; font-size: 0.78rem; color: #abb2bf; }
    .footer { text-align: center; padding: 2rem; color: #555; font-size: 0.8rem; }
    .auth-note { background: #1c1f2b; border-left: 3px solid #56b6c2; padding: 0.75rem 1rem; margin-bottom: 2rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; }
    .auth-note code { color: #56b6c2; }
  </style>
</head>
<body>
  <div class="header">
    <h1>ConnectShare API Reference</h1>
    <p>Remote internet-sharing platform — REST + WebSocket API (v1)</p>
    <div class="base-url">Base URL: ${escapeHtml(appUrl)}</div>
  </div>
  <div class="container">
    <div class="auth-note">
      <strong>Authentication:</strong> All endpoints marked <code>Auth</code> require an
      <code>Authorization: Bearer &lt;accessToken&gt;</code> header. Obtain a token via
      <code>POST /api/v1/auth/register</code> or <code>POST /api/v1/auth/login</code>.
      Access tokens expire in 15 minutes; use <code>POST /api/v1/auth/refresh</code> to rotate.
    </div>
    ${categoriesHtml}
    <div class="footer">
      ConnectShare API v1 &mdash; ${CATEGORIES.reduce((n, c) => n + c.endpoints.length, 0)} endpoints across ${CATEGORIES.length} categories
    </div>
  </div>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
