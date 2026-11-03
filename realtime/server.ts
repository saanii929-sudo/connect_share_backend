/**
 * realtime/server.ts  — ConnectShare WebSocket hub
 *
 * Run:  npx tsx realtime/server.ts
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 * Clients authenticate with { type: "AUTH", token: "<jwt>" }.
 * After auth, they subscribe to topics:
 *
 *   session:<connectionId>         — both creator and connected recipients
 *   creator:<connectionId>         — creator only (join requests, gateway events)
 *   participant:<participantId>    — recipient only (approval, tunnel config)
 *   tunnel:<tunnelIdentifier>      — both sides (handshake, usage)
 *   monitor                        — ADMIN only
 *
 * The Redis subscriber pattern-subscribes to ch:* and forwards to clients
 * whose topic Set matches the incoming channel.
 *
 * ─── Inbound messages from clients ────────────────────────────────────────────
 *
 * Creator → Server:
 *   gateway:register      { connectionId, deviceId }  (ack gateway side-channel)
 *   gateway:heartbeat     { connectionId, ts }
 *   connection:pause      { connectionId }
 *   connection:terminate  { connectionId }
 *   connection:status     { connectionId }
 *
 * Recipient → Server:
 *   connection:join       { token, deviceId }          (informational; real join is REST)
 *   recipient:ready       { participantId }            (tunnel configured locally)
 *   recipient:disconnect  { participantId }
 *   tunnel:handshake      { tunnelIdentifier, ts }     (relay echo, latency tracking)
 *
 * ─── Outbound server events ───────────────────────────────────────────────────
 *   connection:status_changed   { connectionId, status }
 *   connection:participant_joined  { connectionId, participantId }
 *   connection:participant_left    { connectionId, participantId }
 *   connection:participant_approved { connectionId, participantId }
 *   connection:participant_rejected { connectionId, participantId }
 *   connection:terminated          { connectionId }
 *   connection:paused              { connectionId }
 *   connection:activated           { connectionId }
 *   gateway:connected   { connectionId }
 *   gateway:verified    { connectionId }
 *   gateway:failed      { connectionId, reason }
 *   tunnel:established  { tunnelId, participantId }
 *   tunnel:reconnecting { tunnelIdentifier }
 *   tunnel:terminated   { tunnelId }
 *   usage:update        { connectionId, bytesRx, bytesTx, latencyMs }
 */
import { WebSocketServer, WebSocket } from 'ws'
import Redis from 'ioredis'
import { verifyAccessToken } from '../lib/crypto/tokens'
import { logger } from '../lib/logger'
import { getConfig } from '../lib/config/env'
import { REDIS_KEYS } from '../lib/redis'

const cfg = getConfig()

// ─── Client registry ──────────────────────────────────────────────────────────

interface Client {
  ws:           WebSocket
  userId:       string
  role:         string
  deviceId?:    string
  topics:       Set<string>
  connectedAt:  number
}

const clients = new Map<WebSocket, Client>()

// ─── Redis subscriber ──────────────────────────────────────────────────────────

const subscriber = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null })

subscriber.on('error', (err: Error) =>
  logger.error({ err }, 'realtime:redis-error'))

subscriber.psubscribe('ch:*', (err) => {
  if (err) logger.error({ err }, 'realtime:psubscribe-failed')
  else     logger.info('realtime:redis-psubscribed')
})

subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
  // Strip ch: prefix → topic key
  const topic = channel.replace(/^ch:/, '')
  let payload: unknown
  try { payload = JSON.parse(message) } catch { payload = message }

  for (const [, client] of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue
    if (client.topics.has(topic)) {
      send(client.ws, { channel: topic, payload })
    }
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(ws: WebSocket, data: unknown): void {
  try { ws.send(JSON.stringify(data)) } catch { /* ignore */ }
}

function err(ws: WebSocket, code: string, detail?: string): void {
  send(ws, { type: 'ERROR', code, detail })
}

/** Map a topic string to the Redis channel key */
function topicToChannel(topic: string): string {
  // session:<id>       → ch:session:<id>
  // creator:<id>       → ch:creator:<id>
  // participant:<id>   → ch:participant:<id>
  // tunnel:<id>        → ch:tunnel:<id>
  // monitor            → ch:monitor
  return `ch:${topic}`
}

/** Check that a client is authorised to subscribe to a given topic */
function canSubscribe(client: Client, topic: string): boolean {
  if (topic === 'monitor') return client.role === 'ADMIN'
  // All other topics require the user to have a relationship with the resource.
  // We do a lightweight check here; the real auth is in the service layer.
  // session:* and creator:* and participant:* are open to any authed user;
  // the relay server enforces deeper access at the data-plane level.
  return (
    topic.startsWith('session:') ||
    topic.startsWith('creator:') ||
    topic.startsWith('participant:') ||
    topic.startsWith('tunnel:')
  )
}

// ─── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: cfg.REALTIME_PORT })
logger.info({ port: cfg.REALTIME_PORT }, 'realtime:listening')

wss.on('connection', (ws: WebSocket) => {
  const connectedAt = Date.now()
  logger.debug('realtime:client-connected')

  // Kick unauthenticated clients after 10 s
  const authTimeout = setTimeout(() => {
    if (!clients.has(ws)) {
      ws.close(4008, 'Auth timeout')
    }
  }, 10_000)

  ws.on('message', async (raw) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw.toString()) } catch {
      err(ws, 'INVALID_JSON'); return
    }

    const type = msg.type as string

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (type === 'AUTH') {
      clearTimeout(authTimeout)
      try {
        const jwt = await verifyAccessToken(msg.token as string)
        clients.set(ws, {
          ws,
          userId:      jwt.sub!,
          role:        jwt.role,
          deviceId:    jwt.deviceId,
          topics:      new Set(),
          connectedAt,
        })
        send(ws, { type: 'AUTH_OK', userId: jwt.sub, role: jwt.role })
        logger.debug({ userId: jwt.sub }, 'realtime:authed')
      } catch {
        err(ws, 'AUTH_FAILED', 'Invalid or expired token')
        ws.close(4001, 'Unauthorized')
      }
      return
    }

    const client = clients.get(ws)
    if (!client) { err(ws, 'NOT_AUTHENTICATED'); return }

    // ── SUBSCRIBE ─────────────────────────────────────────────────────────────
    if (type === 'SUBSCRIBE') {
      const topic = msg.topic as string
      if (!topic) { err(ws, 'MISSING_TOPIC'); return }
      if (!canSubscribe(client, topic)) {
        send(ws, { type: 'SUBSCRIBE_DENIED', topic }); return
      }
      client.topics.add(topic)
      send(ws, { type: 'SUBSCRIBED', topic })
      return
    }

    if (type === 'UNSUBSCRIBE') {
      const topic = msg.topic as string
      client.topics.delete(topic)
      send(ws, { type: 'UNSUBSCRIBED', topic }); return
    }

    if (type === 'PING') {
      send(ws, { type: 'PONG', ts: Date.now() }); return
    }

    // ── CREATOR MESSAGES ──────────────────────────────────────────────────────
    if (type === 'gateway:register') {
      // Informational — the real registration goes via REST
      send(ws, { type: 'gateway:ack', connectionId: msg.connectionId }); return
    }

    if (type === 'gateway:heartbeat') {
      // Forward to the session channel so the relay can track liveness
      try {
        await subscriber.publish(
          REDIS_KEYS.gatewayChannel(msg.connectionId as string),
          JSON.stringify({ type: 'HEARTBEAT', userId: client.userId, ts: msg.ts }),
        )
      } catch { /* non-critical */ }
      send(ws, { type: 'gateway:heartbeat_ack', ts: Date.now() }); return
    }

    if (type === 'connection:status') {
      // Client asking for a status refresh — they should use REST for authoritative state
      send(ws, { type: 'connection:status_ack', note: 'Use GET /api/v1/connections/:id for authoritative status' }); return
    }

    // ── RECIPIENT MESSAGES ────────────────────────────────────────────────────
    if (type === 'recipient:ready') {
      // Recipient signals their WireGuard interface is configured and up
      const participantId = msg.participantId as string
      try {
        await subscriber.publish(
          REDIS_KEYS.participantChannel(participantId),
          JSON.stringify({ type: 'RECIPIENT_READY', participantId, userId: client.userId }),
        )
      } catch { /* non-critical */ }
      send(ws, { type: 'recipient:ready_ack' }); return
    }

    if (type === 'recipient:disconnect') {
      // Recipient gracefully disconnecting — POST /connections/:id/leave is the authoritative path
      send(ws, { type: 'recipient:disconnect_ack', note: 'Also call POST /api/v1/connections/:id/leave' }); return
    }

    if (type === 'tunnel:handshake') {
      // Latency tracking: client sends ts, server echoes
      send(ws, {
        type:             'tunnel:handshake_ack',
        tunnelIdentifier: msg.tunnelIdentifier,
        clientTs:         msg.ts,
        serverTs:         Date.now(),
      }); return
    }

    err(ws, 'UNKNOWN_MESSAGE_TYPE', type)
  })

  ws.on('close', () => {
    clearTimeout(authTimeout)
    const client = clients.get(ws)
    if (client) {
      logger.debug({ userId: client.userId }, 'realtime:disconnected')
      clients.delete(ws)
    }
  })

  ws.on('error', (e) => {
    logger.warn({ err: e }, 'realtime:ws-error')
    clients.delete(ws)
  })
})

// ─── Metrics endpoint for monitoring ──────────────────────────────────────────

setInterval(() => {
  logger.info({ connectedClients: clients.size }, 'realtime:stats')
}, 60_000)

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  logger.info('realtime:shutdown')
  wss.close(() => {
    subscriber.disconnect()
    process.exit(0)
  })
})
