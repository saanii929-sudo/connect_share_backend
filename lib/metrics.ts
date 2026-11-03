/**
 * lib/metrics.ts
 * Prometheus metrics registry — server-only.
 * prom-client is initialised here (not in instrumentation.ts)
 * so it's available before the first request arrives.
 */
import 'server-only'
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client'

// Single shared registry — avoids duplicate-metric errors across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __metricsRegistry: Registry | undefined
}

export const metricsRegistry: Registry =
  globalThis.__metricsRegistry ?? (() => {
    const r = new Registry()
    collectDefaultMetrics({ register: r, prefix: 'cs_' })
    return r
  })()

if (!globalThis.__metricsRegistry) {
  globalThis.__metricsRegistry = metricsRegistry
}

// ─── Application metrics ──────────────────────────────────────────────────────

function counter(name: string, help: string, labelNames: string[] = []) {
  // Reuse if already registered (hot-reload guard)
  const existing = metricsRegistry.getSingleMetric(name)
  if (existing) return existing as Counter
  return new Counter({ name, help, labelNames, registers: [metricsRegistry] })
}

function gauge(name: string, help: string, labelNames: string[] = []) {
  const existing = metricsRegistry.getSingleMetric(name)
  if (existing) return existing as Gauge
  return new Gauge({ name, help, labelNames, registers: [metricsRegistry] })
}

function histogram(name: string, help: string, buckets: number[], labelNames: string[] = []) {
  const existing = metricsRegistry.getSingleMetric(name)
  if (existing) return existing as Histogram
  return new Histogram({ name, help, buckets, labelNames, registers: [metricsRegistry] })
}

// Sessions
export const sessionsCreated   = counter('cs_sessions_created_total',   'Total sessions created')
export const sessionsActive    = gauge  ('cs_sessions_active',           'Currently active sessions')
export const sessionsExpired   = counter('cs_sessions_expired_total',    'Total sessions expired')
export const sessionsRevoked   = counter('cs_sessions_revoked_total',    'Total sessions revoked')

// Invitations
export const invitationsIssued  = counter('cs_invitations_issued_total',  'Total invite links issued')
export const invitationsClaimed = counter('cs_invitations_claimed_total', 'Total invite links claimed')

// Approvals
export const approvalsGranted  = counter('cs_approvals_granted_total',  'Total approvals granted')
export const approvalsRejected = counter('cs_approvals_rejected_total', 'Total approvals rejected')

// Tunnel peers
export const peersOnline = gauge('cs_peers_online', 'Currently connected tunnel peers')

// Traffic
export const bytesRxTotal = counter('cs_bytes_rx_total', 'Total bytes received by peers',  ['session_id'])
export const bytesTxTotal = counter('cs_bytes_tx_total', 'Total bytes transmitted by peers', ['session_id'])

// ─── Bandwidth & data management (v2) ──────────────────────────────────────────
export const currentBandwidthBps = gauge(
  'cs_bandwidth_bps',
  'Current bandwidth in bytes/sec per connection',
  ['connection_id', 'direction'],   // direction: rx | tx
)
export const dataLimitBytes = gauge(
  'cs_data_limit_bytes',
  'Configured data limit in bytes per connection',
  ['connection_id'],
)
export const dataUsageBytes = gauge(
  'cs_data_usage_bytes',
  'Cumulative data usage in bytes per connection',
  ['connection_id'],
)
export const connectionDurationSeconds = gauge(
  'cs_connection_duration_seconds',
  'Active connection duration in seconds',
  ['connection_id'],
)
export const sessionsTerminatedByLimit = counter(
  'cs_sessions_terminated_by_limit_total',
  'Sessions automatically terminated due to data or time limit',
  ['reason'],   // reason: data_limit | time_limit
)

// ─── Relay capacity (v2) ──────────────────────────────────────────────────────
export const relayGatewaysConnected = gauge(
  'cs_relay_gateways_connected',
  'Number of creator gateways currently connected to the relay',
)
export const relayTunnelsConnected = gauge(
  'cs_relay_tunnels_connected',
  'Number of recipient tunnels currently connected to the relay',
)
export const relayBytesForwarded = counter(
  'cs_relay_bytes_forwarded_total',
  'Total bytes forwarded by the relay',
)
export const relayGatewayVerifications = counter(
  'cs_relay_gateway_verifications_total',
  'Gateway verification attempts',
  ['result'],   // result: success | failure
)

// Auth
export const authRegistrations = counter('cs_auth_registrations_total', 'User registrations')
export const authLogins        = counter('cs_auth_logins_total',        'Successful logins', ['method'])
export const authFailures      = counter('cs_auth_failures_total',      'Failed auth attempts', ['reason'])

// API latency
export const httpRequestDuration = histogram(
  'cs_http_request_duration_seconds',
  'HTTP request latency',
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  ['method', 'route', 'status'],
)
