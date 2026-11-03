/**
 * GET /api/v1/users/me/usage
 */
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { statisticsService } from '@/lib/services/v2/statistics.service'
import { bigIntResponse, apiError } from '@/lib/api-helpers'

export async function GET(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const usage   = await statisticsService.getUserUsage(payload.sub!)
    return bigIntResponse(usage)
  } catch (err) {
    return apiError(err)
  }
}
