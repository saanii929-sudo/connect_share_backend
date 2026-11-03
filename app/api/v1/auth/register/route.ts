
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { authServiceV2 } from '@/lib/services/v2/auth.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'
import { checkRateLimit } from '@/lib/rate-limit'

const schema = z.object({
  fullName: z.string().min(2).max(100),
  email:    z.string().email(),
  password: z.string().min(8).max(128),
})

export async function POST(request: NextRequest) {
  try {
    await checkRateLimit(request, { route: 'v1:auth:register', max: 10 })
    const body   = await parseBody(request, schema)
    const result = await authServiceV2.register(body)
    return ok(result, 201)
  } catch (err) {
    return apiError(err)
  }
}
