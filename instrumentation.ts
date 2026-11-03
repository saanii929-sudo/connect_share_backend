/**
 * instrumentation.ts  (Next.js 16 convention — root of project)
 * Called ONCE when a new Next.js server instance is initialised.
 * Only Node.js-compatible code runs here (no edge runtime).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const isDev = process.env.NODE_ENV !== 'production'

    // Validate environment at startup.
    // In production: fail fast (crash) if misconfigured.
    // In development: warn and continue so the dev server still boots —
    //   individual API routes will surface the error when hit.
    try {
      const { getConfig } = await import('./lib/config/env')
      getConfig()
    } catch (err) {
      if (isDev) {
        console.warn(
          '\n⚠️  Environment validation failed (development mode — continuing):\n' +
          `${err instanceof Error ? err.message : String(err)}\n` +
          '   Copy .env.example to .env and fill in real values.\n' +
          '   Start infra with: docker compose -f docker-compose.dev.yml up -d\n',
        )
      } else {
        // Production — re-throw to halt startup
        throw err
      }
    }

    // Boot the pino logger (triggers a startup log line)
    const { logger } = await import('./lib/logger')
    logger.info(
      { env: process.env.NODE_ENV, nodeVersion: process.version },
      'connectshare:server-start',
    )

    // Register Prometheus default metrics (CPU, memory, event loop)
    await import('./lib/metrics').catch(() => {
      /* metrics init is non-critical */
    })

    // Start the background cleanup worker (stale session expiry,
    // data-limit enforcement, usage buffer flush)
    // Only start if env is valid (worker needs DB/Redis)
    try {
      const { cleanupWorker } = await import('./lib/workers/cleanup-worker')
      cleanupWorker.start()
    } catch {
      /* non-critical in dev without infra */
    }

    logger.info('connectshare:instrumentation-complete')
  }
}
