/**
 * lib/crypto/tokens.ts
 * JWT access/refresh tokens + HMAC invite/device tokens.
 * All operations are server-only and use the jose library.
 */
import 'server-only'
import {
  SignJWT,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { getConfig } from '../config/env'
import { UnauthorizedError } from '../errors'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function enc(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

export interface AccessTokenPayload extends JWTPayload {
  sub: string       // userId
  role: string
  deviceId?: string
}

export interface RefreshTokenPayload extends JWTPayload {
  sub: string       // userId
  jti: string       // unique token id — stored in Redis for revocation
}

export async function signAccessToken(payload: Omit<AccessTokenPayload, 'iss' | 'iat'>): Promise<string> {
  const cfg = getConfig()
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('connectshare')
    .setAudience('connectshare:api')
    .setExpirationTime(cfg.JWT_ACCESS_EXPIRES_IN)
    .sign(enc(cfg.JWT_ACCESS_SECRET))
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const cfg = getConfig()
  try {
    const { payload } = await jwtVerify<AccessTokenPayload>(token, enc(cfg.JWT_ACCESS_SECRET), {
      issuer: 'connectshare',
      audience: 'connectshare:api',
    })
    return payload
  } catch {
    throw new UnauthorizedError('Invalid or expired access token')
  }
}

export async function signRefreshToken(userId: string): Promise<{ token: string; jti: string }> {
  const cfg = getConfig()
  const jti = randomBytes(20).toString('base64url')
  const token = await new SignJWT({ sub: userId, jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('connectshare')
    .setExpirationTime(cfg.JWT_REFRESH_EXPIRES_IN)
    .sign(enc(cfg.JWT_REFRESH_SECRET))
  return { token, jti }
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const cfg = getConfig()
  try {
    const { payload } = await jwtVerify<RefreshTokenPayload>(token, enc(cfg.JWT_REFRESH_SECRET), {
      issuer: 'connectshare',
    })
    return payload
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token')
  }
}

// ─── HMAC invite token ────────────────────────────────────────────────────────

export function generateInviteToken(sessionId: string): string {
  const cfg = getConfig()
  const nonce = randomBytes(16).toString('base64url')
  const payload = `${sessionId}.${nonce}.${Date.now()}`
  const sig = createHmac('sha256', cfg.INVITE_HMAC_SECRET).update(payload).digest('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}

export function verifyInviteToken(token: string): { sessionId: string; nonce: string; ts: number } | null {
  const cfg = getConfig()
  const dotIdx = token.lastIndexOf('.')
  if (dotIdx === -1) return null
  const payloadB64 = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)
  const expectedSig = createHmac('sha256', cfg.INVITE_HMAC_SECRET)
    .update(Buffer.from(payloadB64, 'base64url').toString())
    .digest('base64url')
  // Constant-time compare
  const a = Buffer.from(sig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null
  const [sessionId, nonce, ts] = Buffer.from(payloadB64, 'base64url').toString().split('.')
  return { sessionId, nonce, ts: Number(ts) }
}

// ─── Device token (short-lived, for device attestation) ──────────────────────

export function generateDeviceToken(userId: string, fingerprint: string): string {
  const cfg = getConfig()
  const nonce = randomBytes(12).toString('base64url')
  const ts = Date.now()
  const payload = `${userId}.${fingerprint}.${nonce}.${ts}`
  const sig = createHmac('sha256', cfg.DEVICE_TOKEN_SECRET).update(payload).digest('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}

export function verifyDeviceToken(
  token: string,
): { userId: string; fingerprint: string; ts: number } | null {
  const cfg = getConfig()
  const dotIdx = token.lastIndexOf('.')
  if (dotIdx === -1) return null
  const payloadB64 = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)
  const expectedSig = createHmac('sha256', cfg.DEVICE_TOKEN_SECRET)
    .update(Buffer.from(payloadB64, 'base64url').toString())
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [userId, fingerprint, , ts] = Buffer.from(payloadB64, 'base64url').toString().split('.')
  return { userId, fingerprint, ts: Number(ts) }
}
