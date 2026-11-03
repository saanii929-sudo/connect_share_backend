
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { participantService } from '@/lib/services/v2/participant.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({
  participantId: z.string().min(1),
  reason:        z.string().max(200).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload = await requireAuth(request)
    const body    = await parseBody(request, schema)
    const result  = await participantService.reject(payload.sub!, body.participantId, body.reason)
    return ok(result)
  } catch (err) {
    return apiError(err)
  }
}
