/**
 * GET /api/v1/connections/history
 */
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { connectionService } from '@/lib/services/v2/connection.service'
import { ok, apiError } from '@/lib/api-helpers'

export async function GET(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const history = await connectionService.listHistory(payload.sub!)
    return ok(history)
  } catch (err) {
    return apiError(err)
  }
}
