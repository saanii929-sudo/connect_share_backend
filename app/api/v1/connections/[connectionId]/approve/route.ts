
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { participantService } from '@/lib/services/v2/participant.service'
import { tunnelSessionService } from '@/lib/services/v2/tunnel-session.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ participantId: z.string().min(1) })

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload          = await requireAuth(request)
    const { connectionId } = await params
    const { participantId } = await parseBody(request, schema)

    // 1. Creator approves the participant
    const participant = await participantService.approve(payload.sub!, participantId)

    // 2. Immediately provision tunnel — returns peerConfig ONCE
    const tunnelResult = await tunnelSessionService.provision({
      participantId,
      connectionId,
      deviceId: participant.deviceId,
    })

    return ok({
      participant,
      tunnel: {
        tunnelId:    tunnelResult.tunnelId,
        peerConfig:  tunnelResult.peerConfig,   // plaintext wg-quick conf — send to recipient
        tunnelToken: tunnelResult.tunnelToken,
      },
    })
  } catch (err) {
    return apiError(err)
  }
}
