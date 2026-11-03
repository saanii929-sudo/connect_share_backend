/**
 * lib/crypto/device-auth.ts
 *
 * Device challenge-response authentication.
 *
 * A device is NEVER trusted based solely on its submitted device ID.
 * Instead:
 *   1. Client requests a challenge: POST /api/v1/devices/challenge { deviceId }
 *   2. Server issues a random nonce, stores it in Redis (single-use, 60s TTL),
 *      returns { nonce, deviceId }
 *   3. Client signs the nonce with the device's Ed25519 private key
 *   4. Client submits: POST /api/v1/devices/verify { deviceId, nonce, signature }
 *   5. Server looks up the stored public key, verifies the signature, deletes
 *      the nonce (single-use → replay protection)
 *   6. Server issues a short-lived device token
 *
 * Replay protection: nonces are single-use, stored in Redis with a short TTL.
 * A captured challenge cannot be replayed because the nonce is consumed on
 * first use.
 */
import 'server-only'
import {
  randomBytes,
  createPublicKey,
  createVerify,
  type KeyObject,
} from 'crypto'
import { redis, REDIS_KEYS } from '../redis'

const CHALLENGE_TTL_S = 60   // 60 seconds to complete the challenge

/**
 * Issue a fresh challenge nonce for a device.
 * Stores nonce in Redis keyed by deviceId. Overwrites any prior challenge.
 */
export async function issueChallenge(deviceId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url')
  await redis.set(REDIS_KEYS.deviceChallenge(deviceId), nonce, 'EX', CHALLENGE_TTL_S)
  return nonce
}

/**
 * Verify a device's signature against the issued challenge.
 * Consumes the nonce (single-use) regardless of result.
 *
 * @param deviceId    The device claiming to authenticate
 * @param nonce       The nonce returned by issueChallenge
 * @param signature   Ed25519 signature of the nonce, base64
 * @param publicKey   The device's stored Ed25519 public key (base64 SPKI or raw)
 * @returns true if the signature is valid AND the nonce matches the one issued
 */
export async function verifyChallenge(input: {
  deviceId:   string
  nonce:      string
  signature:  string
  publicKey:  string
}): Promise<boolean> {
  const { deviceId, nonce, signature, publicKey } = input

  // 1. Retrieve + consume the stored nonce (single-use → replay protection)
  const storedNonce = await redis.getdel(REDIS_KEYS.deviceChallenge(deviceId))
  if (!storedNonce || storedNonce !== nonce) {
    return false   // nonce mismatch, expired, or already used
  }

  // 2. Verify the Ed25519 signature
  try {
    const pubKeyObj = parseEd25519PublicKey(publicKey)
    // Ed25519: algorithm is inferred from key type, pass undefined not null
    const verifier = createVerify('')
    verifier.update(nonce, 'utf8')
    return verifier.verify(pubKeyObj, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/**
 * Parse an Ed25519 public key from base64.
 * Accepts both raw 32-byte keys and SPKI-encoded keys.
 */
function parseEd25519PublicKey(b64: string): KeyObject {
  const buf = Buffer.from(b64, 'base64')
  // Raw 32-byte Ed25519 public key → wrap in SPKI
  if (buf.length === 32) {
    return createPublicKey({
      key: wrapRawEd25519InSpki(buf),
      format: 'der',
      type: 'spki',
    })
  }
  // Assume SPKI-encoded already
  return createPublicKey({ key: buf, format: 'der', type: 'spki' })
}

/**
 * Wrap a raw 32-byte Ed25519 public key in an ASN.1 SPKI envelope.
 * Ed25519 OID: 1.3.101.112
 */
function wrapRawEd25519InSpki(raw: Buffer): Buffer {
  // SPKI for Ed25519:
  //   SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING <32 bytes> }
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70])           // OID 1.3.101.112
  const algoSeq = Buffer.concat([Buffer.from([0x30, oid.length]), oid])
  const bitStringContent = Buffer.concat([Buffer.from([0x00]), raw])  // 0 unused bits + key
  const bitString = Buffer.concat([
    Buffer.from([0x03, bitStringContent.length]),
    bitStringContent,
  ])
  const spkiContent = Buffer.concat([algoSeq, bitString])
  return Buffer.concat([Buffer.from([0x30, spkiContent.length]), spkiContent])
}
