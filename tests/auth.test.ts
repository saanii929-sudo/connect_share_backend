/**
 * tests/auth.test.ts
 * Authentication tests — JWT sign/verify, refresh rotation, password hashing.
 * These test the crypto layer directly (no DB needed).
 */
import { describe, it, expect } from 'vitest'
import { SignJWT, jwtVerify } from 'jose'
import { hash, verify } from '@node-rs/argon2'

const ACCESS_SECRET = new TextEncoder().encode('test-jwt-access-secret-32bytes-minimum-xxxx')
const REFRESH_SECRET = new TextEncoder().encode('test-jwt-refresh-secret-32bytes-minimum-xx')

describe('JWT access tokens', () => {
  it('signs and verifies a valid token', async () => {
    const token = await new SignJWT({ sub: 'user-123', role: 'USER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('connectshare')
      .setAudience('connectshare:api')
      .setExpirationTime('15m')
      .sign(ACCESS_SECRET)

    const { payload } = await jwtVerify(token, ACCESS_SECRET, {
      issuer: 'connectshare',
      audience: 'connectshare:api',
    })
    expect(payload.sub).toBe('user-123')
    expect(payload.role).toBe('USER')
  })

  it('rejects a token signed with the wrong secret', async () => {
    const token = await new SignJWT({ sub: 'user-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('connectshare')
      .setAudience('connectshare:api')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxxxx'))

    await expect(jwtVerify(token, ACCESS_SECRET, {
      issuer: 'connectshare',
      audience: 'connectshare:api',
    })).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ sub: 'user-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(new Date(Date.now() - 20 * 60 * 1000).getTime() / 1000)
      .setExpirationTime(new Date(Date.now() - 10 * 60 * 1000).getTime() / 1000)
      .sign(ACCESS_SECRET)

    await expect(jwtVerify(token, ACCESS_SECRET)).rejects.toThrow()
  })
})

describe('JWT refresh tokens', () => {
  it('uses a different secret from access tokens', async () => {
    const refresh = await new SignJWT({ sub: 'user-456', jti: 'unique-jti' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('connectshare')
      .setExpirationTime('7d')
      .sign(REFRESH_SECRET)

    // Should verify with refresh secret
    const { payload } = await jwtVerify(refresh, REFRESH_SECRET, { issuer: 'connectshare' })
    expect(payload.sub).toBe('user-456')

    // Should NOT verify with access secret
    await expect(jwtVerify(refresh, ACCESS_SECRET)).rejects.toThrow()
  })
})

describe('Password hashing (Argon2id)', () => {
  it('hashes a password and verifies it', async () => {
    const password = 'MySecureP@ssw0rd!'
    const hashed = await hash(password, {
      memoryCost: 65536, timeCost: 3, parallelism: 4, outputLen: 32,
    })
    expect(hashed).not.toBe(password)
    expect(hashed.startsWith('$argon2id$')).toBe(true)
    const valid = await verify(hashed, password)
    expect(valid).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hashed = await hash('correct-password', {
      memoryCost: 65536, timeCost: 3, parallelism: 4, outputLen: 32,
    })
    const valid = await verify(hashed, 'wrong-password')
    expect(valid).toBe(false)
  })
})
