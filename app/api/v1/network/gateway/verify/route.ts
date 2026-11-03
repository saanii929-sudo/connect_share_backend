/**
 * POST /api/v1/network/gateway/verify
 * Internal endpoint called by the relay server after traffic-forwarding
 * verification succeeds. Protected by RELAY_AUTH_SECRET.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { gatewayService } from '@/lib/services/v2/gateway.service'
import { noContent, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ connectionId: z.string().min(1) })

export async function POST(request: NextRequest) {
  try {
    const relayAuth = request.headers.get('authorization') ?? ''
    const { connectionId } = await parseBody(request, schema)
    await gatewayService.verifyGateway({ connectionId, relayAuthHeader: relayAuth })
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
