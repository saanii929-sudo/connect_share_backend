/**
 * lib/redis.ts
 * Ioredis singleton — lazy-init so build-time evaluation never tries to connect.
 */
import 'server-only'
import Redis from 'ioredis'
import { logger } from './logger'

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined
}

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    // Exponential back-off: 200ms → 400ms → … → 5s cap, max 10 reconnect attempts
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.warn({ times }, 'redis:giving-up-reconnect')
        return null
      }
      return Math.min(times * 200, 5000)
    },
  })
  client.on('connect', () => logger.info('redis:connected'))
  client.on('error',   (err: Error) => logger.error({ err }, 'redis:error'))
  client.on('close',   () => logger.warn('redis:connection-closed'))
  return client
}

let _redisInstance: Redis | undefined

export function getRedis(): Redis {
  if (globalThis.__redis) return globalThis.__redis
  if (!_redisInstance) {
    _redisInstance = createRedisClient()
    if (process.env.NODE_ENV !== 'production') globalThis.__redis = _redisInstance
  }
  return _redisInstance
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return (getRedis() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

// ─── Redis key namespace ──────────────────────────────────────────────────────

export const REDIS_KEYS = {
  // Auth
  refreshToken:      (jti: string)          => `rt:${jti}`,
  deviceToken:       (fingerprint: string)  => `dt:${fingerprint}`,
  // Device challenge-response (replay protection — single-use nonces)
  deviceChallenge:   (deviceId: string)      => `dch:${deviceId}`,

  // Invitations — store hash→connectionId for O(1) validation
  inviteHash:        (hash: string)         => `inv:${hash}`,

  // Connection state
  connectionState:   (id: string)           => `conn:${id}:state`,
  connectionGateway: (id: string)           => `conn:${id}:gateway`,

  // Gateway presence
  gatewayOnline:     (connectionId: string) => `gw:${connectionId}:online`,
  gatewayHeartbeat:  (connectionId: string) => `gw:${connectionId}:hb`,

  // Participant / tunnel
  participantStatus: (participantId: string) => `part:${participantId}:status`,
  tunnelOnline:      (tunnelId: string)       => `tunnel:${tunnelId}:online`,

  // Rate limiting
  rateLimitBucket:   (ip: string, route: string) => `rl:${ip}:${route}`,

  // Usage buffering (accumulate before DB flush)
  usageBuffer:       (connectionId: string) => `usage:${connectionId}:buf`,

  // ─── Pub/sub channels ────────────────────────────────────────────────────
  // Creator receives: join requests, participant events
  creatorChannel:    (connectionId: string) => `ch:creator:${connectionId}`,
  // Participant receives: approval decisions, tunnel config, status
  participantChannel:(participantId: string) => `ch:participant:${participantId}`,
  // Both sides: session-wide events (PAUSED, TERMINATED, etc.)
  sessionChannel:    (connectionId: string) => `ch:session:${connectionId}`,
  // Gateway/relay coordination (internal)
  gatewayChannel:    (connectionId: string) => `ch:gateway:${connectionId}`,
  // Admin monitor stream
  monitorChannel:    ()                      => 'ch:monitor',
} as const
