
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { participantService } from '@/lib/services/v2/participant.service'
import { noContent, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ participantId: z.string().min(1) })

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload       = await requireAuth(request)
    const { participantId } = await parseBody(request, schema)
    await participantService.leave(payload.sub!, participantId)
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
