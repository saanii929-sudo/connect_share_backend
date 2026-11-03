/**
 * POST /api/v1/connections/create
 *
 * Creator workflow step 1: create the connection record and provision
 * WireGuard server keys. Returns the connectionId and expiresAt.
 * The gateway token is issued in the separate gateway/register step.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { deviceServiceV2 } from '@/lib/services/v2/device.service'
import { connectionService } from '@/lib/services/v2/connection.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({
  creatorDeviceId: z.string().min(1),
  title:           z.string().min(1).max(120).optional(),
  maxRecipients:   z.number().int().min(1).max(50).optional(),
  // How long this connection is valid for, in seconds (min 5 min, max 7 days)
  expiresIn:       z.number().int().min(300).max(604800),
  // Public endpoint address where the relay/gateway listens (e.g. "203.0.113.5:51820")
  endpoint:        z.string().min(7).max(253),
  // Optional bandwidth / data caps
  maxBytesTotal:     z.number().int().positive().optional(),
  bandwidthLimitBps: z.number().int().positive().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const payload = await requireAuth(request)

    // Validate device ownership before any further work
    await deviceServiceV2.assertOwned(payload.sub!, (await parseBody(request.clone(), schema)).creatorDeviceId)

    const body   = await parseBody(request, schema)
    const result = await connectionService.create({
      creatorUserId:   payload.sub!,
      creatorDeviceId: body.creatorDeviceId,
      title:           body.title,
      maxRecipients:   body.maxRecipients,
      expiresIn:       body.expiresIn,
      endpoint:        body.endpoint,
      maxBytesTotal:     body.maxBytesTotal,
      bandwidthLimitBps: body.bandwidthLimitBps,
    })
    return ok(result, 201)
  } catch (err) {
    return apiError(err)
  }
}
