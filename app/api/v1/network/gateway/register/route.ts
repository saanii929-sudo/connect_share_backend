/**
 * POST /api/v1/network/gateway/register
 *
 * Creator calls this after creating a connection and is ready to
 * establish the outbound gateway tunnel. Returns:
 *   - gatewayToken: short-lived JWT for relay WebSocket auth
 *   - serverConfig: wg-quick .conf text (write to wg0.conf on Linux host)
 *   - relayUrl:     WebSocket URL to connect the gateway to
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { gatewayService } from '@/lib/services/v2/gateway.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({
  connectionId:    z.string().min(1),
  creatorDeviceId: z.string().min(1),
})

export async function POST(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const body    = await parseBody(request, schema)
    const result  = await gatewayService.register({
      creatorUserId:   payload.sub!,
      creatorDeviceId: body.creatorDeviceId,
      connectionId:    body.connectionId,
    })
    return ok(result)
  } catch (err) {
    return apiError(err)
  }
}
