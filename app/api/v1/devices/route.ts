/**
 * GET /api/v1/devices
 */
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { deviceServiceV2 } from '@/lib/services/v2/device.service'
import { ok, apiError } from '@/lib/api-helpers'

export async function GET(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const devices = await deviceServiceV2.listByUser(payload.sub!)
    return ok(devices)
  } catch (err) {
    return apiError(err)
  }
}
