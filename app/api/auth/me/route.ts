
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { getCurrentUser } from '@/lib/auth/session'
import { ok, apiError } from '@/lib/api-helpers'

export async function GET(request: NextRequest) {
  try {
    const payload = await requireAuth(request)
    const user    = await getCurrentUser(payload)
    return ok(user)
  } catch (err) {
    return apiError(err)
  }
}
