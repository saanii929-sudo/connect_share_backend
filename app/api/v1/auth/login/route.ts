
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { authServiceV2 } from '@/lib/services/v2/auth.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'
import { checkRateLimit } from '@/lib/rate-limit'

const schema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

export async function POST(request: NextRequest) {
  try {
    await checkRateLimit(request, { route: 'v1:auth:login', max: 20 })
    const body   = await parseBody(request, schema)
    const result = await authServiceV2.login(body)
    return ok(result)
  } catch (err) {
    return apiError(err)
  }
}
