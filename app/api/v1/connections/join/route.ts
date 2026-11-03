/**
 * POST /api/v1/connections/join
 *
 * Recipient workflow:
 *   1. Validate token
 *   2. Claim the invitation slot
 *   3. Create pending participant record
 *   4. Notify creator via WebSocket
 *   5. Return participantId (recipient polls GET /approvals/:id for status)
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { deviceServiceV2 } from '@/lib/services/v2/device.service'
import { invitationServiceV2 } from '@/lib/services/v2/invitation.service'
import { participantService } from '@/lib/services/v2/participant.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'
import { BadRequestError } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'

const schema = z.object({
  token:    z.string().min(10),
  deviceId: z.string().min(1),
})

export async function POST(request: NextRequest) {
  try {
    await checkRateLimit(request, { route: 'v1:connections:join', max: 10 })
    const payload = await requireAuth(request)
    const body    = await parseBody(request, schema)

    // Verify device ownership (never trust a submitted deviceId without this check)
    await deviceServiceV2.assertOwned(payload.sub!, body.deviceId)

    // Validate token
    const validation = await invitationServiceV2.validate(body.token)
    if (!validation.valid) {
      throw new BadRequestError(validation.error ?? 'Invalid invitation token')
    }

    // Atomically claim one use slot
    await invitationServiceV2.claim(validation.invitationId, payload.sub!)

    // Record join request — creator is notified via event service
    const result = await participantService.join({
      userId:       payload.sub!,
      deviceId:     body.deviceId,
      invitationId: validation.invitationId,
      connectionId: validation.connectionId,
    })

    return ok({
      participantId: result.participantId,
      connectionId:  validation.connectionId,
      message:       'Join request submitted — awaiting creator approval',
    }, 201)
  } catch (err) {
    return apiError(err)
  }
}
