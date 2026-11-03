/**
 * DELETE /api/v1/devices/:deviceId
 */
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { deviceServiceV2 } from '@/lib/services/v2/device.service'
import { noContent, apiError } from '@/lib/api-helpers'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  try {
    const payload        = await requireAuth(request)
    const { deviceId }   = await params
    await deviceServiceV2.revoke(payload.sub!, deviceId)
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
