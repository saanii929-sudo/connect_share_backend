
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { rotateRefreshToken } from '@/lib/auth/session'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const schema = z.object({ refreshToken: z.string().min(1) })

export async function POST(request: NextRequest) {
  try {
    const { refreshToken } = await parseBody(request, schema)
    const tokens = await rotateRefreshToken(refreshToken)
    return ok(tokens)
  } catch (err) {
    return apiError(err)
  }
}
