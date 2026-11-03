/**
 * POST /api/v1/network/tunnel/establish
 *
 * Called by the relay server when a recipient's tunnel has passed
 * verification. Marks the tunnel ACTIVE and activates routing.
 * Protected by RELAY_AUTH_SECRET.
 */
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { tunnelSessionService } from '@/lib/services/v2/tunnel-session.service'
import { noContent, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ tunnelIdentifier: z.string().min(1) })

export async function POST(request: NextRequest) {
  try {
    const relayAuth       = request.headers.get('authorization') ?? ''
    const { tunnelIdentifier } = await parseBody(request, schema)
    await tunnelSessionService.markEstablished({ tunnelIdentifier, relayAuthHeader: relayAuth })
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
