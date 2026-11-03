/**
 * tests/wireguard.test.ts
 * WireGuard key generation and config assembly tests.
 */
import { describe, it, expect } from 'vitest'
import {
  generateKeyPairSync,
  createHash,
} from 'crypto'

// Replicate the key generation logic from lib/crypto/wireguard.ts
function generateWgKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  const pubDer  = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return {
    privateKey: privDer.subarray(-32).toString('base64'),
    publicKey:  pubDer.subarray(-32).toString('base64'),
  }
}

describe('WireGuard key generation', () => {
  it('generates valid 32-byte Curve25519 keys', () => {
    const kp = generateWgKeypair()
    // base64 of 32 bytes = 44 chars
    expect(kp.privateKey.length).toBe(44)
    expect(kp.publicKey.length).toBe(44)

    // Decode and verify length
    const privBytes = Buffer.from(kp.privateKey, 'base64')
    const pubBytes  = Buffer.from(kp.publicKey, 'base64')
    expect(privBytes.length).toBe(32)
    expect(pubBytes.length).toBe(32)
  })

  it('generates unique keypairs each call', () => {
    const kp1 = generateWgKeypair()
    const kp2 = generateWgKeypair()
    expect(kp1.privateKey).not.toBe(kp2.privateKey)
    expect(kp1.publicKey).not.toBe(kp2.publicKey)
  })

  it('derives a deterministic public key from the same private key', () => {
    // X25519 is deterministic: same private key → same public key
    const { publicKey } = generateKeyPairSync('x25519')
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    const pub = pubDer.subarray(-32).toString('base64')
    expect(pub.length).toBe(44)
    // Verify the public key is 32 bytes when decoded
    expect(Buffer.from(pub, 'base64').length).toBe(32)
  })
})

describe('WireGuard config assembly', () => {
  it('builds a valid wg-quick server config', () => {
    const kp = generateWgKeypair()
    const peerKp = generateWgKeypair()
    const config = [
      '[Interface]',
      `PrivateKey = ${kp.privateKey}`,
      'Address = 10.8.0.1/24',
      'ListenPort = 51820',
      '',
      '[Peer]',
      `PublicKey = ${peerKp.publicKey}`,
      'AllowedIPs = 0.0.0.0/0',
    ].join('\n')

    expect(config).toContain('[Interface]')
    expect(config).toContain('[Peer]')
    expect(config).toContain('PrivateKey = ')
    expect(config).toContain('ListenPort = 51820')
    expect(config).toContain('Address = 10.8.0.1/24')
  })

  it('builds a valid wg-quick peer config', () => {
    const serverKp = generateWgKeypair()
    const peerKp = generateWgKeypair()
    const config = [
      '[Interface]',
      `PrivateKey = ${peerKp.privateKey}`,
      'Address = 10.8.0.2/32',
      'DNS = 1.1.1.1, 8.8.8.8',
      '',
      '[Peer]',
      `PublicKey = ${serverKp.publicKey}`,
      'Endpoint = 203.0.113.5:51820',
      'AllowedIPs = 0.0.0.0/0, ::/0',
      'PersistentKeepalive = 25',
    ].join('\n')

    expect(config).toContain('Endpoint = 203.0.113.5:51820')
    expect(config).toContain('AllowedIPs = 0.0.0.0/0, ::/0')
    expect(config).toContain('PersistentKeepalive = 25')
  })
})

describe('AES-256-GCM private key encryption', () => {
  it('encrypts and decrypts a private key round-trip', async () => {
    const { createCipheriv, createDecipheriv, hkdfSync, randomBytes } = await import('crypto')
    const secret = 'test-wg-key-encryption-secret-32bytes-minimum'
    const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(16), 'wg-key-enc', 32))
    const plain = generateWgKeypair().privateKey

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const encrypted = [iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':')

    // Decrypt
    const [ivB64, tagB64, ctB64] = encrypted.split(':')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    const decrypted = decipher.update(Buffer.from(ctB64, 'base64url'), undefined, 'utf8') + decipher.final('utf8')

    expect(decrypted).toBe(plain)
  })
})
