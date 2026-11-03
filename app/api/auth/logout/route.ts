
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { rotateRefreshToken, revokeRefreshToken } from '@/lib/auth/session'
import { verifyRefreshToken } from '@/lib/crypto/tokens'
import { noContent, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ refreshToken: z.string().min(1) })

export async function POST(request: NextRequest) {
  try {
    const { refreshToken } = await parseBody(request, schema)
    try {
      const payload = await verifyRefreshToken(refreshToken)
      if (payload.jti) await revokeRefreshToken(payload.jti)
    } catch {
    }
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
