/**
 * lib/rate-limit.ts
 * Redis-backed sliding window rate limiter for Route Handlers.
 */
import 'server-only'
import { redis, REDIS_KEYS } from './redis'
import { TooManyRequestsError } from './errors'
import { getConfig } from './config/env'
import { type NextRequest } from 'next/server'

export interface RateLimitOptions {
  windowMs?: number
  max?:      number
  route:     string
}

export async function checkRateLimit(
  request: NextRequest,
  opts: RateLimitOptions,
): Promise<void> {
  const cfg = getConfig()
  const windowMs = opts.windowMs ?? cfg.RATE_LIMIT_WINDOW_MS
  const max      = opts.max      ?? cfg.RATE_LIMIT_MAX

  // Prefer X-Forwarded-For in production, fall back to remote addr
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'

  const key     = REDIS_KEYS.rateLimitBucket(ip, opts.route)
  const windowS = Math.ceil(windowMs / 1000)

  const current = await redis.incr(key)
  if (current === 1) {
    await redis.expire(key, windowS)
  }

  if (current > max) {
    const ttl = await redis.ttl(key)
    throw new TooManyRequestsError(ttl * 1000)
  }
}
