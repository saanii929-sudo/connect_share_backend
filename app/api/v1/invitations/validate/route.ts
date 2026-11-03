/**
 * POST /api/v1/invitations/validate
 * Public endpoint — validate a token without claiming it.
 * Recipient calls this first to show connection info before joining.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { invitationServiceV2 } from '@/lib/services/v2/invitation.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'
import { db } from '@/lib/db'

const schema = z.object({ token: z.string().min(10) })

export async function POST(request: NextRequest) {
  try {
    const { token }  = await parseBody(request, schema)
    const validation = await invitationServiceV2.validate(token)

    if (!validation.valid) {
      return ok({ valid: false, error: validation.error }, 200)
    }

    // Return safe connection metadata (no private keys)
    const conn = await db.connection.findUnique({
      where:  { id: validation.connectionId },
      select: {
        id:            true,
        title:         true,
        sessionStatus: true,
        maxRecipients: true,
        expiresAt:     true,
        creator: {
          select: { id: true, fullName: true },
        },
      },
    })

    return ok({ valid: true, connectionId: validation.connectionId, connection: conn })
  } catch (err) {
    return apiError(err)
  }
}
