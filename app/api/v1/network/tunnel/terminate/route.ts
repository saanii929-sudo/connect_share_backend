/**
 * POST /api/v1/network/tunnel/terminate
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { tunnelSessionService } from '@/lib/services/v2/tunnel-session.service'
import { noContent, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ tunnelId: z.string().min(1) })

export async function POST(request: NextRequest) {
  try {
    const payload      = await requireAuth(request)
    const { tunnelId } = await parseBody(request, schema)
    await tunnelSessionService.terminate(payload.sub!, tunnelId)
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
