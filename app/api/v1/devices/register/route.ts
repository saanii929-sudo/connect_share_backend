/**
 * POST /api/v1/devices/register
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { deviceServiceV2 } from '@/lib/services/v2/device.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const PLATFORMS = ['ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'WEB', 'UNKNOWN'] as const

const schema = z.object({
  deviceName:  z.string().min(1).max(100),
  platform:    z.enum(PLATFORMS),
  appVersion:  z.string().max(50).optional(),
  publicKey:   z.string().min(40),
})

export async function POST(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const body    = await parseBody(request, schema)
    const result  = await deviceServiceV2.register(payload.sub!, {
      ...body,
      userAgent: request.headers.get('user-agent') ?? undefined,
    })
    return ok(result, 201)
  } catch (err) {
    return apiError(err)
  }
}
