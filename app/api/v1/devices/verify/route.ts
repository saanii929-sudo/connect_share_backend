/**
 * POST /api/v1/devices/verify
 * Verify a device challenge-response signature and issue a device token.
 *
 * Replay protection: the nonce is consumed (deleted from Redis) on first
 * use regardless of result. A captured challenge cannot be replayed.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { db } from '@/lib/db'
import { verifyChallenge } from '@/lib/crypto/device-auth'
import { generateDeviceToken } from '@/lib/crypto/tokens'
import { redis, REDIS_KEYS } from '@/lib/redis'
import { ok, apiError, parseBody } from '@/lib/api-helpers'
import { UnauthorizedError, NotFoundError } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'

const DEVICE_TOKEN_TTL = 3600

const schema = z.object({
  deviceId:   z.string().min(1),
  nonce:      z.string().min(10),
  signature:  z.string().min(10),
})

export async function POST(request: NextRequest) {
  try {
    await checkRateLimit(request, { route: 'v1:device:verify', max: 30 })
    const payload = await requireAuth(request)
    const body    = await parseBody(request, schema)

    // Look up the device and verify ownership
    const device = await db.device.findUnique({ where: { id: body.deviceId } })
    if (!device) throw new NotFoundError('Device')
    if (device.userId !== payload.sub) throw new UnauthorizedError('Device does not belong to user')
    if (device.deviceStatus === 'REVOKED') throw new UnauthorizedError('Device is revoked')

    // Verify the challenge-response signature (consumes the nonce)
    const valid = await verifyChallenge({
      deviceId:   body.deviceId,
      nonce:       body.nonce,
      signature:   body.signature,
      publicKey:   device.publicKey,
    })

    if (!valid) {
      throw new UnauthorizedError('Invalid signature or expired/already-used challenge')
    }

    // Issue a short-lived device token
    const deviceToken = generateDeviceToken(payload.sub, device.fingerprint)
    await redis.setex(REDIS_KEYS.deviceToken(device.fingerprint), DEVICE_TOKEN_TTL, payload.sub)

    // Touch lastSeen
    await db.device.update({
      where: { id: body.deviceId },
      data:  { lastSeenAt: new Date() },
    })

    return ok({ verified: true, deviceToken, expiresIn: DEVICE_TOKEN_TTL })
  } catch (err) {
    return apiError(err)
  }
}
