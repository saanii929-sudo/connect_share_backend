/**
 * GET /api/v1/network/tunnel/:tunnelId/status
 */
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { tunnelSessionService } from '@/lib/services/v2/tunnel-session.service'
import { ok, apiError } from '@/lib/api-helpers'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tunnelId: string }> },
) {
  try {
    const payload      = await requireAuth(request)
    const { tunnelId } = await params
    const status       = await tunnelSessionService.getStatus(payload.sub!, tunnelId)
    return ok(status)
  } catch (err) {
    return apiError(err)
  }
}
