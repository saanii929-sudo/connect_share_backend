/**
 * POST /api/v1/devices/challenge
 * Issue a challenge nonce for device authentication.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { db } from '@/lib/db'
import { issueChallenge } from '@/lib/crypto/device-auth'
import { ok, apiError, parseBody } from '@/lib/api-helpers'
import { NotFoundError, ForbiddenError } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'

const schema = z.object({ deviceId: z.string().min(1) })

export async function POST(request: NextRequest) {
  try {
    await checkRateLimit(request, { route: 'v1:device:challenge', max: 30 })
    const payload   = await requireAuth(request)
    const { deviceId } = await parseBody(request, schema)

    // Verify device exists and belongs to the authenticated user
    const device = await db.device.findUnique({ where: { id: deviceId } })
    if (!device) throw new NotFoundError('Device')
    if (device.userId !== payload.sub) throw new ForbiddenError()

    const nonce = await issueChallenge(deviceId)
    return ok({ deviceId, nonce, algorithm: 'Ed25519' })
  } catch (err) {
    return apiError(err)
  }
}
