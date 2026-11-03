
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { statisticsService } from '@/lib/services/v2/statistics.service'
import { bigIntResponse, apiError } from '@/lib/api-helpers'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload          = await requireAuth(request)
    const { connectionId } = await params
    const stats            = await statisticsService.getConnectionStats(payload.sub!, connectionId)
    return bigIntResponse(stats)
  } catch (err) {
    return apiError(err)
  }
}
