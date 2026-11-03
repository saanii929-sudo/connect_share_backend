
import { type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { metricsRegistry } = await import('@/lib/metrics')

  // Optional bearer-token guard
  const metricsToken = process.env.METRICS_BEARER_TOKEN
  if (metricsToken) {
    const auth = request.headers.get('authorization') ?? ''
    if (auth !== `Bearer ${metricsToken}`) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  const metrics = await metricsRegistry.metrics()
  return new Response(metrics, {
    status:  200,
    headers: { 'Content-Type': metricsRegistry.contentType },
  })
}
