
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { connectionService } from '@/lib/services/v2/connection.service'
import { ok, apiError } from '@/lib/api-helpers'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload          = await requireAuth(request)
    const { connectionId } = await params
    const conn             = await connectionService.terminate(payload.sub!, connectionId)
    return ok(conn)
  } catch (err) {
    return apiError(err)
  }
}
