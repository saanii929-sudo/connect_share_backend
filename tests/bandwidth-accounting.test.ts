/**
 * tests/bandwidth-accounting.test.ts
 * Tests the bandwidth accounting logic — token bucket rate limiting
 * and byte accumulation.
 */
import { describe, it, expect } from 'vitest'

// Replicate the token bucket from relay/server.ts
interface TokenBucket {
  tokens: number
  capacity: number
  refillRateBps: number
  lastRefillTs: number
}

function createBucket(limitBps: number): TokenBucket {
  return {
    tokens: limitBps,
    capacity: limitBps,
    refillRateBps: limitBps,
    lastRefillTs: Date.now(),
  }
}

function enforce(bucket: TokenBucket, bytes: number, limitBps?: number | null): boolean {
  if (!limitBps || limitBps <= 0) return true
  const now = Date.now()
  const elapsed = (now - bucket.lastRefillTs) / 1000
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRateBps)
  bucket.lastRefillTs = now
  if (bucket.tokens >= bytes) {
    bucket.tokens -= bytes
    return true
  }
  return false
}

describe('Token bucket bandwidth limiting', () => {
  it('allows traffic when no limit is set', () => {
    const bucket = createBucket(1_000_000)
    // limitBps = null means unlimited
    expect(enforce(bucket, 999_999, null)).toBe(true)
    expect(enforce(bucket, 999_999, 0)).toBe(true)
  })

  it('allows initial burst up to capacity', () => {
    const limit = 1_000_000 // 1 MB/s
    const bucket = createBucket(limit)
    // Initial tokens = capacity = 1_000_000
    expect(enforce(bucket, 500_000, limit)).toBe(true)   // uses 500k
    expect(bucket.tokens).toBeLessThanOrEqual(500_000)
    expect(bucket.tokens).toBeGreaterThan(499_000)       // ~500k (small refill)
    expect(enforce(bucket, 500_000, limit)).toBe(true)     // uses remaining
    // After exhausting, a tiny amount may have refilled — allow small delta
    expect(bucket.tokens).toBeLessThan(1000)
  })

  it('drops packets when bucket is exhausted', () => {
    const limit = 100_000 // 100 KB/s
    const bucket = createBucket(limit)
    // Exhaust the bucket
    expect(enforce(bucket, 100_000, limit)).toBe(true)
    // Next packet should be dropped (no tokens left, no time elapsed)
    expect(enforce(bucket, 1, limit)).toBe(false)
  })

  it('refills tokens over time', async () => {
    const limit = 1_000_000 // 1 MB/s
    const bucket = createBucket(limit)
    // Exhaust
    enforce(bucket, 1_000_000, limit)
    expect(bucket.tokens).toBe(0)
    // Wait 50ms → refills 50_000 tokens
    await new Promise(r => setTimeout(r, 50))
    expect(enforce(bucket, 40_000, limit)).toBe(true)   // should now have ~10k left
  })

  it('does not exceed capacity on refill', async () => {
    const limit = 100_000
    const bucket = createBucket(limit)
    // Don't use any tokens; wait a long time
    await new Promise(r => setTimeout(r, 100))
    enforce(bucket, 0, limit)
    // Should be capped at capacity
    expect(bucket.tokens).toBeLessThanOrEqual(limit)
  })
})

describe('Byte accumulation', () => {
  it('accumulates BigInt totals correctly', () => {
    let total = BigInt(0)
    total += BigInt(1024)
    total += BigInt(2048)
    total += BigInt(4096)
    expect(total).toBe(BigInt(7168))
    expect(total.toString()).toBe('7168')
  })

  it('handles large values (GB range)', () => {
    const oneGB = BigInt(1024 * 1024 * 1024)
    let total = BigInt(0)
    for (let i = 0; i < 5; i++) total += oneGB
    expect(total).toBe(BigInt(5) * oneGB)
    expect(total.toString()).toBe('5368709120')
  })

  it('separates upload and download counters', () => {
    const stats = {
      bytesUploaded: BigInt(1024),
      bytesDownloaded: BigInt(2048),
    }
    const total = stats.bytesUploaded + stats.bytesDownloaded
    expect(total).toBe(BigInt(3072))
    expect(stats.bytesUploaded).toBe(BigInt(1024))
    expect(stats.bytesDownloaded).toBe(BigInt(2048))
  })
})
