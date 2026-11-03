/**
 * POST /api/v1/network/gateway/heartbeat
 * Creator's agent calls this every ~15 s to keep the gateway alive.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { gatewayService } from '@/lib/services/v2/gateway.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({
  connectionId: z.string().min(1),
  bytesRx:      z.number().int().nonnegative().optional(),
  bytesTx:      z.number().int().nonnegative().optional(),
  latencyMs:    z.number().nonnegative().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const body    = await parseBody(request, schema)
    const status  = await gatewayService.heartbeat({
      creatorUserId: payload.sub!,
      connectionId:  body.connectionId,
      bytesRx:       body.bytesRx,
      bytesTx:       body.bytesTx,
      latencyMs:     body.latencyMs,
    })
    return ok(status)
  } catch (err) {
    return apiError(err)
  }
}
