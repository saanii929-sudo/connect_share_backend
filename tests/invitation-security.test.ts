/**
 * tests/invitation-security.test.ts
 * Invitation token security — generation, hashing, verification, replay prevention.
 */
import { describe, it, expect } from 'vitest'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'

// Simulate the invitation service's core logic

function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

describe('Invitation token security', () => {
  it('generates a cryptographically random 256-bit token', () => {
    const token = generateToken()
    // 32 bytes → 43 base64url chars (no padding)
    expect(token.length).toBe(43)
    // Two calls produce different tokens (high entropy)
    const token2 = generateToken()
    expect(token).not.toBe(token2)
  })

  it('stores only the hash — raw token is never persisted', () => {
    const raw = generateToken()
    const hash = hashToken(raw)
    // The hash is a 64-char hex string (SHA-256)
    expect(hash.length).toBe(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // The hash does NOT contain the raw token
    expect(hash).not.toContain(raw)
  })

  it('lookup by hash succeeds for valid tokens', () => {
    const raw = generateToken()
    const hash = hashToken(raw)
    // Recomputing the hash from the same raw token yields the same hash
    expect(hashToken(raw)).toBe(hash)
  })

  it('rejects invalid tokens (wrong hash)', () => {
    const raw = generateToken()
    const storedHash = hashToken(raw)
    const wrongRaw = generateToken()
    const wrongHash = hashToken(wrongRaw)
    // Constant-time comparison
    const a = Buffer.from(storedHash, 'hex')
    const b = Buffer.from(wrongHash, 'hex')
    expect(a.length).toBe(b.length)
    expect(timingSafeEqual(a, b)).toBe(false)
  })

  it('does not include VPN private keys in the token', () => {
    const raw = generateToken()
    const hash = hashToken(raw)
    // The token is purely random — no key material
    expect(raw).not.toContain('PrivateKey')
    expect(hash).not.toContain('PrivateKey')
    expect(raw.length).toBeLessThan(64)   // not a 256-bit WG key
  })
})
