/**
 * lib/auth/session.ts
 * Session management: issue, refresh, revoke tokens.
 * Refresh tokens are tracked in Redis (jti → userId) for revocation.
 */
import 'server-only'
import { redis, REDIS_KEYS } from '../redis'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type AccessTokenPayload,
} from '../crypto/tokens'
import { UnauthorizedError } from '../errors'
import { getConfig } from '../config/env'
import { db } from '../db'

export interface AuthTokens {
  accessToken:  string
  refreshToken: string
  expiresIn:    number // seconds
}

// Parse a duration string like "15m" or "7d" to seconds
function durationToSeconds(d: string): number {
  const match = d.match(/^(\d+)([smhd])$/)
  if (!match) return 900
  const n = Number(match[1])
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
  return n * (unit[match[2]] ?? 1)
}

export async function issueTokens(userId: string, role: string, deviceId?: string): Promise<AuthTokens> {
  const cfg = getConfig()
  const [accessToken, { token: refreshToken, jti }] = await Promise.all([
    signAccessToken({ sub: userId, role, ...(deviceId ? { deviceId } : {}) }),
    signRefreshToken(userId),
  ])

  const refreshTTL = durationToSeconds(cfg.JWT_REFRESH_EXPIRES_IN)
  await redis.setex(REDIS_KEYS.refreshToken(jti), refreshTTL, userId)

  return {
    accessToken,
    refreshToken,
    expiresIn: durationToSeconds(cfg.JWT_ACCESS_EXPIRES_IN),
  }
}

export async function rotateRefreshToken(oldRefreshToken: string): Promise<AuthTokens> {
  const payload = await verifyRefreshToken(oldRefreshToken)
  const storedUserId = await redis.get(REDIS_KEYS.refreshToken(payload.jti!))

  if (!storedUserId || storedUserId !== payload.sub) {
    throw new UnauthorizedError('Refresh token revoked or invalid')
  }

  // Revoke old token — one-time use
  await redis.del(REDIS_KEYS.refreshToken(payload.jti!))

  // Look up user's current role for the new access token
  const user = await db.user.findUnique({ where: { id: payload.sub! }, select: { role: true } })
  if (!user) throw new UnauthorizedError('User not found')

  return issueTokens(payload.sub!, user.role)
}

export async function revokeRefreshToken(jti: string): Promise<void> {
  await redis.del(REDIS_KEYS.refreshToken(jti))
}

export async function getCurrentUser(
  payload: AccessTokenPayload,
) {
  const user = await db.user.findUnique({
    where:  { id: payload.sub },
    select: {
      id: true, email: true, fullName: true, role: true,
      status: true, createdAt: true, deletedAt: true,
    },
  })
  if (!user || user.deletedAt) throw new UnauthorizedError('User not found or deactivated')
  return user
}
