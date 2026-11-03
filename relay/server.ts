
import 'server-only'
import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { createServer } from 'http'
import { Registry, collectDefaultMetrics, Gauge, Counter } from 'prom-client'
import { getConfig } from '../lib/config/env'
import { verifyAccessToken } from '../lib/crypto/tokens'
import { logger } from '../lib/logger'
import { redis, REDIS_KEYS } from '../lib/redis'

const cfg = getConfig()

const MAGIC    = Buffer.from([0xc5, 0xf0, 0x01, 0x00])
const FRAME_DATA      = 0x01
const FRAME_PROBE     = 0x02
const FRAME_PROBE_ACK = 0x03
const FRAME_CONTROL   = 0x04
const HEADER_LEN      = 7   // 4 magic + 1 type + 2 length

function buildFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(HEADER_LEN)
  MAGIC.copy(header, 0)
  header[4] = type
  header.writeUInt16BE(payload.length, 5)
  return Buffer.concat([header, payload])
}

function parseFrame(buf: Buffer): { type: number; payload: Buffer } | null {
  if (buf.length < HEADER_LEN) return null
  if (!buf.subarray(0, 4).equals(MAGIC)) return null
  const type    = buf[4]
  const len     = buf.readUInt16BE(5)
  if (buf.length < HEADER_LEN + len) return null
  return { type, payload: buf.subarray(HEADER_LEN, HEADER_LEN + len) }
}

type Role = 'GATEWAY' | 'TUNNEL'

interface RelayClient {
  ws:            WebSocket
  userId:        string
  role:          Role
  connectionId:  string
  deviceId?:     string
  tunnelId?:     string       // for TUNNEL clients
  probesSent:    number
  probesAcked:   number
  verified:      boolean
  bytesForwarded: bigint
}

const gateways  = new Map<string, RelayClient>()
const tunnels   = new Map<string, RelayClient>()
const bySocket  = new Map<WebSocket, RelayClient>()

// ─── Relay Prometheus metrics ─────────────────────────────────────────────────
const relayRegistry = new Registry()
collectDefaultMetrics({ register: relayRegistry, prefix: 'cs_relay_' })
const mGatewaysConnected = new Gauge({
  name: 'cs_relay_gateways_connected',
  help: 'Creator gateways currently connected',
  registers: [relayRegistry],
})
const mTunnelsConnected = new Gauge({
  name: 'cs_relay_tunnels_connected',
  help: 'Recipient tunnels currently connected',
  registers: [relayRegistry],
})
const mBytesForwarded = new Counter({
  name: 'cs_relay_bytes_forwarded_total',
  help: 'Total bytes forwarded by the relay',
  registers: [relayRegistry],
})
const mGatewayVerifications = new Counter({
  name: 'cs_relay_gateway_verifications_total',
  help: 'Gateway verification attempts',
  labelNames: ['result'],
  registers: [relayRegistry],
})
const mGatewayHeartbeats = new Counter({
  name: 'cs_relay_gateway_heartbeats_total',
  help: 'Gateway heartbeats received',
  registers: [relayRegistry],
})

// ─── Per-tunnel token bucket (bandwidth limiting) ────────────────────────────
/**
 * Token bucket bandwidth limiter per tunnel.
 * If connection.bandwidthLimitBps is set, the relay enforces a per-tunnel
 * rate cap. Tokens refill at bandwidthLimitBps bytes/sec.
 * Packets exceeding the rate are dropped (not queued — prevents buffer bloat).
 */
interface TokenBucket {
  tokens: number
  capacity: number
  refillRateBps: number
  lastRefillTs: number
}
const bandwidthBuckets = new Map<string, TokenBucket>()
// Per-tunnel bandwidth limit (bytes/sec), populated when tunnel connects
const tunnelLimitBpsMap = new Map<string, number>()

function enforceBandwidthLimit(tunnelIdentifier: string, bytes: number, limitBps?: number | null): boolean {
  // Use per-tunnel limit if available, otherwise the global default
  if (!limitBps || limitBps <= 0) return true   // no limit
  let bucket = bandwidthBuckets.get(tunnelIdentifier)
  if (!bucket) {
    bucket = {
      tokens: limitBps,
      capacity: limitBps,
      refillRateBps: limitBps,
      lastRefillTs: Date.now(),
    }
    bandwidthBuckets.set(tunnelIdentifier, bucket)
  }
  const b = bucket   // narrow to non-undefined
  // Refill tokens based on elapsed time
  const now = Date.now()
  const elapsed = (now - b.lastRefillTs) / 1000
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillRateBps)
  b.lastRefillTs = now
  if (b.tokens >= bytes) {
    b.tokens -= bytes
    return true   // allowed
  }
  return false    // rate-limited — drop
}

// ─── Relay HTTP metrics server (separate port from WS) ───────────────────────
const METRICS_PORT = cfg.RELAY_PORT + 1000
const metricsServer = createServer((_req, res) => {
  mGatewaysConnected.set(gateways.size)
  mTunnelsConnected.set(tunnels.size)
  res.setHeader('Content-Type', relayRegistry.contentType)
  relayRegistry.metrics().then(m => res.end(m))
})
metricsServer.listen(METRICS_PORT, () =>
  logger.info({ port: METRICS_PORT }, 'relay:metrics-listening'))

const VERIFY_ATTEMPTS = cfg.GATEWAY_VERIFY_ATTEMPTS ?? 3

async function sendProbe(client: RelayClient): Promise<void> {
  if (client.ws.readyState !== WebSocket.OPEN) return
  const probe = buildFrame(
    FRAME_PROBE,
    Buffer.from(JSON.stringify({ seq: client.probesSent, ts: Date.now() })),
  )
  client.ws.send(probe)
  client.probesSent++
  logger.debug({ connectionId: client.connectionId, seq: client.probesSent }, 'relay:probe-sent')
}

async function handleProbeAck(client: RelayClient, payload: Buffer): Promise<void> {
  client.probesAcked++
  logger.debug({
    connectionId: client.connectionId,
    acked: client.probesAcked,
    required: VERIFY_ATTEMPTS,
  }, 'relay:probe-acked')

  if (client.probesAcked >= VERIFY_ATTEMPTS && !client.verified) {
    client.verified = true
    logger.info({ connectionId: client.connectionId }, 'relay:gateway-verified')
    mGatewayVerifications.inc({ result: 'success' })

    try {
      const apiUrl = `${cfg.APP_URL}/api/v1/network/gateway/verify`
      await fetch(apiUrl, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cfg.RELAY_AUTH_SECRET ?? ''}`,
        },
        body: JSON.stringify({ connectionId: client.connectionId }),
      })
    } catch (err) {
      logger.error({ err, connectionId: client.connectionId }, 'relay:verify-callback-failed')
    }

    await redis.publish(
      REDIS_KEYS.sessionChannel(client.connectionId),
      JSON.stringify({ type: 'gateway:verified', connectionId: client.connectionId }),
    )
  }
}

function routeToGateway(tunnelClient: RelayClient, frame: Buffer): void {
  const gateway = gateways.get(tunnelClient.connectionId)
  if (!gateway || gateway.ws.readyState !== WebSocket.OPEN) return
  if (!gateway.verified) return
  // Enforce per-tunnel bandwidth limit (token bucket)
  const limit = tunnelLimitBpsMap.get(tunnelClient.tunnelId ?? '')
  const allowed = enforceBandwidthLimit(tunnelClient.tunnelId ?? '', frame.length, limit)
  if (!allowed) return   // rate-limited — drop
  gateway.ws.send(frame)
  mBytesForwarded.inc(frame.length)
  tunnelClient.bytesForwarded += BigInt(frame.length)
}


function routeToTunnel(gatewayClient: RelayClient, tunnelIdentifier: string, frame: Buffer): void {
  const tunnel = tunnels.get(tunnelIdentifier)
  if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) return
  tunnel.ws.send(frame)
  mBytesForwarded.inc(frame.length)
  gatewayClient.bytesForwarded += BigInt(frame.length)
}

async function handleBinary(client: RelayClient, buf: Buffer): Promise<void> {
  const frame = parseFrame(buf)
  if (!frame) {
    logger.warn({ connectionId: client.connectionId }, 'relay:bad-frame')
    return
  }

  switch (frame.type) {
    case FRAME_DATA: {
      if (client.role === 'TUNNEL') {
        // Recipient → gateway
        routeToGateway(client, buf)
      } else if (client.role === 'GATEWAY') {
        const header = frame.payload.subarray(0, 40).toString('utf8').replace(/\0/g, '').trim()
        routeToTunnel(client, header, buf)
      }
      break
    }
    case FRAME_PROBE_ACK: {
      if (client.role === 'GATEWAY') await handleProbeAck(client, frame.payload)
      break
    }
    case FRAME_CONTROL: {
      let ctrl: Record<string, unknown>
      try { ctrl = JSON.parse(frame.payload.toString()) } catch { return }

      if (ctrl.type === 'TUNNEL_READY' && client.role === 'TUNNEL') {
        const tunnelId = ctrl.tunnelIdentifier as string
        try {
          await fetch(`${cfg.APP_URL}/api/v1/network/tunnel/establish`, {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${cfg.RELAY_AUTH_SECRET ?? ''}`,
            },
            body: JSON.stringify({ tunnelIdentifier: tunnelId }),
          })
        } catch (err) {
          logger.error({ err }, 'relay:tunnel-establish-callback-failed')
        }
      }

      if (ctrl.type === 'USAGE_REPORT' && client.role === 'GATEWAY') {
        await redis.publish(
          REDIS_KEYS.sessionChannel(client.connectionId),
          JSON.stringify({
            type:         'usage:update',
            connectionId: client.connectionId,
            bytesRx:      ctrl.bytesRx,
            bytesTx:      ctrl.bytesTx,
            latencyMs:    ctrl.latencyMs,
          }),
        )
      }
      break
    }
  }
}

const wss = new WebSocketServer({ port: cfg.RELAY_PORT })
logger.info({ port: cfg.RELAY_PORT }, 'relay:listening')

wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
  logger.debug('relay:client-connecting')

  const authTimeout = setTimeout(() => {
    if (!bySocket.has(ws)) ws.close(4008, 'Auth timeout')
  }, 10_000)

  ws.once('message', async (raw) => {
    clearTimeout(authTimeout)
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw.toString()) } catch {
      ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_JSON' }))
      ws.close(4002, 'Bad auth frame')
      return
    }

    if (msg.type !== 'AUTH') {
      ws.send(JSON.stringify({ type: 'ERROR', code: 'AUTH_REQUIRED' }))
      ws.close(4003, 'Auth required')
      return
    }

    let jwtPayload: Awaited<ReturnType<typeof verifyAccessToken>>
    try {
      jwtPayload = await verifyAccessToken(msg.token as string)
    } catch {
      ws.send(JSON.stringify({ type: 'AUTH_FAIL', error: 'Invalid token' }))
      ws.close(4001, 'Unauthorized')
      return
    }

    const role = jwtPayload.role as Role
    const connectionId = (jwtPayload as unknown as Record<string, string>).connectionId

    if (!connectionId) {
      ws.send(JSON.stringify({ type: 'AUTH_FAIL', error: 'Missing connectionId in token' }))
      ws.close(4004, 'Missing connectionId')
      return
    }
    if (role !== 'GATEWAY' && role !== 'TUNNEL') {
      ws.send(JSON.stringify({ type: 'AUTH_FAIL', error: 'Invalid role' }))
      ws.close(4005, 'Invalid role')
      return
    }

    const client: RelayClient = {
      ws,
      userId:        jwtPayload.sub!,
      role,
      connectionId,
      deviceId:      jwtPayload.deviceId,
      tunnelId:      (msg.tunnelIdentifier as string | undefined),
      probesSent:    0,
      probesAcked:   0,
      verified:      false,
      bytesForwarded: BigInt(0),
    }

    bySocket.set(ws, client)

    if (role === 'GATEWAY') {
      gateways.set(connectionId, client)
      ws.send(JSON.stringify({ type: 'AUTH_OK', role: 'GATEWAY', connectionId }))
      logger.info({ connectionId, userId: jwtPayload.sub }, 'relay:gateway-connected')

      await redis.set(REDIS_KEYS.gatewayOnline(connectionId), '1', 'EX', 45)
      await redis.publish(
        REDIS_KEYS.sessionChannel(connectionId),
        JSON.stringify({ type: 'gateway:connected', connectionId }),
      )

      for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
        await new Promise<void>(res => setTimeout(res, 1000))
        await sendProbe(client)
      }
    } else {
      const tunnelIdentifier = msg.tunnelIdentifier as string
      if (!tunnelIdentifier) {
        ws.send(JSON.stringify({ type: 'AUTH_FAIL', error: 'tunnelIdentifier required for TUNNEL role' }))
        ws.close(4006, 'Missing tunnelIdentifier')
        return
      }
      client.tunnelId = tunnelIdentifier
      tunnels.set(tunnelIdentifier, client)
      ws.send(JSON.stringify({ type: 'AUTH_OK', role: 'TUNNEL', tunnelIdentifier, connectionId }))
      logger.info({ tunnelIdentifier, connectionId, userId: jwtPayload.sub }, 'relay:tunnel-connected')

      // Fetch the connection's bandwidth limit and cache it for this tunnel
      try {
        const res = await fetch(`${cfg.APP_URL}/api/v1/connections/${connectionId}`, {
          headers: { Authorization: `Bearer ${msg.token as string}` },
        })
        if (res.ok) {
          const json = await res.json() as { data?: { bandwidthLimitBps?: number } }
          if (json.data?.bandwidthLimitBps) {
            tunnelLimitBpsMap.set(tunnelIdentifier, json.data.bandwidthLimitBps)
          }
        }
      } catch { /* non-critical — default to unlimited */ }

      await redis.set(REDIS_KEYS.tunnelOnline(tunnelIdentifier), '1', 'EX', 60)
    }

    ws.on('message', (data) => {
      if (Buffer.isBuffer(data)) {
        handleBinary(client, data).catch(e =>
          logger.error({ err: e }, 'relay:handle-error'))
      }
    })

    ws.on('close', async () => {
      logger.info({ connectionId, role }, 'relay:client-disconnected')
      bySocket.delete(ws)

      if (role === 'GATEWAY') {
        gateways.delete(connectionId)
        await redis.del(REDIS_KEYS.gatewayOnline(connectionId))
        await redis.publish(
          REDIS_KEYS.sessionChannel(connectionId),
          JSON.stringify({ type: 'gateway:disconnected', connectionId }),
        )

        if (client.verified) {
          fetch(`${cfg.APP_URL}/api/v1/network/gateway/verify`, {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${cfg.RELAY_AUTH_SECRET ?? ''}`,
            },
            body: JSON.stringify({ connectionId, failed: true }),
          }).catch(() => { /* best-effort */ })
        }
      } else {
        const tunnelIdentifier = client.tunnelId!
        tunnels.delete(tunnelIdentifier)
        await redis.del(REDIS_KEYS.tunnelOnline(tunnelIdentifier))
        await redis.publish(
          REDIS_KEYS.sessionChannel(connectionId),
          JSON.stringify({ type: 'tunnel:disconnected', tunnelIdentifier, connectionId }),
        )
      }
    })

    ws.on('error', (e) => {
      logger.warn({ err: e, connectionId, role }, 'relay:ws-error')
    })
  })
})


setInterval(async () => {
  for (const [connectionId, client] of gateways) {
    if (client.bytesForwarded > BigInt(0)) {
      try {
        await redis.publish(
          REDIS_KEYS.sessionChannel(connectionId),
          JSON.stringify({
            type:         'usage:update',
            connectionId,
            bytesTx:      client.bytesForwarded.toString(),
          }),
        )
        client.bytesForwarded = BigInt(0)
      } catch { /* non-critical */ }
    }
  }
}, 15_000)

setInterval(() => {
  logger.info({
    gateways: gateways.size,
    tunnels:  tunnels.size,
  }, 'relay:stats')
}, 60_000)


process.on('SIGTERM', () => {
  logger.info('relay:shutting-down')
  wss.close(() => process.exit(0))
})
