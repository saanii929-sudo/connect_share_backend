
import { type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { redis } from '@/lib/redis'

export async function GET(_request: NextRequest) {
  const checks: Record<string, 'ok' | 'fail'> = {}

  try {
    await db.$queryRaw`SELECT 1`
    checks.database = 'ok'
  } catch {
    checks.database = 'fail'
  }

  try {
    await redis.ping()
    checks.redis = 'ok'
  } catch {
    checks.redis = 'fail'
  }

  const healthy = Object.values(checks).every(v => v === 'ok')

  return Response.json(
    { status: healthy ? 'ok' : 'degraded', checks, ts: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  )
}
