/**
 * lib/crypto/wireguard.ts
 * WireGuard key generation and config file assembly.
 *
 * Key generation:
 *   Uses Node.js built-in `crypto.generateKeyPairSync('x25519')`.
 *   The raw 32-byte Curve25519 key is extracted from the DER envelope
 *   and base64-encoded — the exact format wg(8) expects.
 *
 * Config assembly:
 *   Pure TypeScript — generates the wg-quick .conf content as a string.
 *   Actual `wg setconf` / `wg-quick up` must run on a Linux host with
 *   NET_ADMIN capabilities. This module only coordinates key material
 *   and config text; it does NOT exec any subprocess.
 *
 * Encryption at rest:
 *   Private keys are AES-256-GCM encrypted before DB storage.
 *   The WG_KEY_ENCRYPTION_SECRET env var is used to derive the key.
 */
import 'server-only'
import {
  generateKeyPairSync,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto'
import { getConfig } from '../config/env'

// ─── Key Generation ───────────────────────────────────────────────────────────

export interface WgKeypair {
  privateKey: string  // base64, 32 bytes — WireGuard PrivateKey
  publicKey:  string  // base64, 32 bytes — WireGuard PublicKey
}

/**
 * Generate a Curve25519 (X25519) keypair for WireGuard.
 * The raw 32-byte key is the last 32 bytes of the PKCS8 DER for the private key
 * and the last 32 bytes of the SubjectPublicKeyInfo DER for the public key.
 */
export function generateWgKeypair(): WgKeypair {
  const { privateKey: privKey, publicKey: pubKey } =
    generateKeyPairSync('x25519')

  const privDer = privKey.export({ type: 'pkcs8',  format: 'der' }) as Buffer
  const pubDer  = pubKey.export({ type: 'spki', format: 'der' }) as Buffer

  return {
    privateKey: privDer.subarray(-32).toString('base64'),
    publicKey:  pubDer.subarray(-32).toString('base64'),
  }
}

// ─── Symmetric encryption for private keys at rest ───────────────────────────

function deriveAesKey(): Buffer {
  const cfg = getConfig()
  return Buffer.from(
    hkdfSync('sha256', cfg.WG_KEY_ENCRYPTION_SECRET, Buffer.alloc(16), 'wg-key-enc', 32),
  )
}

export function encryptPrivateKey(base64Key: string): string {
  const key = deriveAesKey()
  const iv  = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct  = Buffer.concat([cipher.update(base64Key, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv(12):tag(16):ciphertext — all base64url
  return [iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':')
}

export function decryptPrivateKey(encrypted: string): string {
  const key = deriveAesKey()
  const parts = encrypted.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted key format')
  const [ivB64, tagB64, ctB64] = parts
  const iv     = Buffer.from(ivB64,  'base64url')
  const tag    = Buffer.from(tagB64, 'base64url')
  const ct     = Buffer.from(ctB64,  'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8')
}

// ─── IP allocation ────────────────────────────────────────────────────────────

/**
 * Given a /24 base like "10.8.0.0/24", allocate the next peer address.
 * Server takes .1, peers take .2, .3, …
 * Returns "10.8.0.N/32" for a peer.
 */
export function allocatePeerAddress(baseSubnet: string, peerIndex: number): string {
  const [base] = baseSubnet.split('/')
  const parts = base.split('.').map(Number)
  parts[3] = peerIndex + 2 // .1 is server
  return `${parts.join('.')}/32`
}

export function serverAddressFromSubnet(baseSubnet: string): string {
  const [base, mask] = baseSubnet.split('/')
  const parts = base.split('.').map(Number)
  parts[3] = 1
  return `${parts.join('.')}/${mask}`
}

// ─── Config file assembly ─────────────────────────────────────────────────────

export interface WgServerConfigOptions {
  privateKey:  string      // server private key (plain base64)
  address:     string      // e.g. "10.8.0.1/24"
  listenPort:  number
  peers: WgPeerInfo[]
  postUp?:     string[]    // iptables / nft rules for NAT
  preDown?:    string[]
}

export interface WgPeerInfo {
  publicKey:  string
  allowedIPs: string
  endpoint?:  string  // only if the peer is another server
  keepalive?: number
}

export interface WgPeerConfigOptions {
  privateKey:     string
  address:        string   // peer address, e.g. "10.8.0.2/32"
  serverPublicKey: string
  serverEndpoint: string   // "host:port"
  dns?:           string   // e.g. "1.1.1.1, 8.8.8.8"
  allowedIPs?:    string   // defaults to "0.0.0.0/0, ::/0" (full tunnel)
  keepalive?:     number
}

export function buildServerConfig(opts: WgServerConfigOptions): string {
  const postUp = opts.postUp ?? defaultPostUp(opts.address)
  const preDown = opts.preDown ?? defaultPreDown(opts.address)

  const peerBlocks = opts.peers.map(p => [
    '[Peer]',
    `PublicKey = ${p.publicKey}`,
    `AllowedIPs = ${p.allowedIPs}`,
    ...(p.endpoint   ? [`Endpoint = ${p.endpoint}`]               : []),
    ...(p.keepalive  ? [`PersistentKeepalive = ${p.keepalive}`]   : []),
  ].join('\n')).join('\n\n')

  return [
    '[Interface]',
    `PrivateKey = ${opts.privateKey}`,
    `Address = ${opts.address}`,
    `ListenPort = ${opts.listenPort}`,
    `PostUp = ${postUp.join('; ')}`,
    `PreDown = ${preDown.join('; ')}`,
    '',
    peerBlocks,
  ].join('\n')
}

export function buildPeerConfig(opts: WgPeerConfigOptions): string {
  return [
    '[Interface]',
    `PrivateKey = ${opts.privateKey}`,
    `Address = ${opts.address}`,
    ...(opts.dns ? [`DNS = ${opts.dns}`] : ['DNS = 1.1.1.1, 8.8.8.8']),
    '',
    '[Peer]',
    `PublicKey = ${opts.serverPublicKey}`,
    `Endpoint = ${opts.serverEndpoint}`,
    `AllowedIPs = ${opts.allowedIPs ?? '0.0.0.0/0, ::/0'}`,
    `PersistentKeepalive = ${opts.keepalive ?? 25}`,
  ].join('\n')
}

// ─── Default NAT rules (nftables-style) ──────────────────────────────────────
// These must run on the Linux host that owns the real internet connection.
// The WireGuard interface is named wg0 by convention; the outbound interface
// (eth0, ens3, etc.) must be substituted at deployment time via the env
// WG_OUTBOUND_IFACE. Provided here as defaults that the operator can override.

function defaultPostUp(address: string): string[] {
  const outIface = process.env.WG_OUTBOUND_IFACE ?? 'eth0'
  return [
    `iptables -A FORWARD -i wg0 -j ACCEPT`,
    `iptables -A FORWARD -o wg0 -j ACCEPT`,
    `iptables -t nat -A POSTROUTING -o ${outIface} -j MASQUERADE`,
    `ip6tables -A FORWARD -i wg0 -j ACCEPT`,
    `ip6tables -t nat -A POSTROUTING -o ${outIface} -j MASQUERADE`,
    `sysctl -w net.ipv4.ip_forward=1`,
    `sysctl -w net.ipv6.conf.all.forwarding=1`,
  ]
}

function defaultPreDown(address: string): string[] {
  const outIface = process.env.WG_OUTBOUND_IFACE ?? 'eth0'
  return [
    `iptables -D FORWARD -i wg0 -j ACCEPT`,
    `iptables -D FORWARD -o wg0 -j ACCEPT`,
    `iptables -t nat -D POSTROUTING -o ${outIface} -j MASQUERADE`,
    `ip6tables -D FORWARD -i wg0 -j ACCEPT`,
    `ip6tables -t nat -D POSTROUTING -o ${outIface} -j MASQUERADE`,
  ]
}
