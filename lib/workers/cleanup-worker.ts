/**
 * lib/workers/cleanup-worker.ts
 *
 * Background job runner — can be invoked from instrumentation.ts (interval)
 * or as a standalone process (tsx lib/workers/cleanup-worker.ts).
 *
 * Jobs:
 *   1. Expire stale connections (past expiresAt)
 *   2. Terminate connections that exceeded maxBytesTotal
 *   3. Flush buffered usage statistics from Redis to the database
 *
 * This ensures automatic session termination does NOT depend on a client
 * polling the API — it runs server-side on a schedule.
 */
import 'server-only'
import { db } from '../db'
import { redis, REDIS_KEYS } from '../redis'
import { connectionService } from '../services/v2/connection.service'
import { statisticsService } from '../services/v2/statistics.service'
import { eventService } from '../services/v2/event.service'
import { sessionsTerminatedByLimit } from '../metrics'
import { logger } from '../logger'

const SWEEP_INTERVAL_MS = 60_000   // 1 minute

export class CleanupWorker {
  private timer: ReturnType<typeof setInterval> | null = null

  start(intervalMs: number = SWEEP_INTERVAL_MS): void {
    if (this.timer) return
    logger.info({ intervalMs }, 'cleanup-worker:started')
    this.timer = setInterval(() => {
      this.tick().catch(err =>
        logger.error({ err }, 'cleanup-worker:tick-failed'),
      )
    }, intervalMs)
    // Don't keep the process alive just for this timer
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info('cleanup-worker:stopped')
    }
  }

  async tick(): Promise<void> {
    await Promise.allSettled([
      this.expireStaleConnections(),
      this.enforceDataLimits(),
      this.flushUsageBuffers(),
    ])
  }

  /**
   * Expire connections past their expiresAt timestamp.
   */
  private async expireStaleConnections(): Promise<void> {
    const count = await connectionService.expireStale()
    if (count > 0) {
      logger.info({ count }, 'cleanup-worker:expired-connections')
      // Emit events for each expired connection
      const expired = await db.connection.findMany({
        where:   { sessionStatus: 'EXPIRED', disconnectedAt: { gte: new Date(Date.now() - 120_000) } },
        select:  { id: true },
      })
      for (const conn of expired) {
        await eventService.emit(conn.id, 'CONNECTION_EXPIRED').catch(() => {})
      }
    }
  }

  /**
   * Terminate connections that have exceeded their maxBytesTotal limit.
   * Usage is accumulated from usage_statistics.
   */
  private async enforceDataLimits(): Promise<void> {
    // Find active connections with a data limit set
    const connections = await db.connection.findMany({
      where: {
        sessionStatus: { in: ['ACTIVE', 'READY', 'PAUSED'] },
        maxBytesTotal: { not: null },
      },
      select: { id: true, maxBytesTotal: true, creatorUserId: true },
    })

    for (const conn of connections) {
      const stats = await statisticsService.getConnectionStats(conn.creatorUserId!, conn.id).catch(() => null)
      if (!stats) continue

      const totalBytes = BigInt(stats.totalBytesUploaded) + BigInt(stats.totalBytesDownloaded)
      if (conn.maxBytesTotal && totalBytes >= conn.maxBytesTotal) {
        logger.info({ connectionId: conn.id, totalBytes: totalBytes.toString(), limit: conn.maxBytesTotal.toString() }, 'cleanup-worker:data-limit-exceeded')
        await connectionService.terminate(conn.creatorUserId!, conn.id).catch(() => {})
        sessionsTerminatedByLimit.inc({ reason: 'data_limit' })
        await eventService.emit(conn.id, 'CONNECTION_TERMINATED', { reason: 'data_limit' }).catch(() => {})
      }
    }
  }

  /**
   * Flush any buffered usage data from Redis to the database.
   * The relay and gateway write usage snapshots to a Redis list; this worker
   * drains the list and bulk-inserts into usage_statistics.
   */
  private async flushUsageBuffers(): Promise<void> {
    // Find all active connection IDs from Redis
    const keys = await redis.keys('usage:*:buf')
    for (const key of keys) {
      const connectionId = key.split(':')[1]
      if (!connectionId) continue
      // Drain the buffer list
      const items = await redis.lrange(key, 0, -1)
      if (items.length === 0) continue
      await redis.del(key)

      for (const item of items) {
        try {
          const data = JSON.parse(item) as {
            participantId?: string
            bytesUploaded: string
            bytesDownloaded: string
            latencyMs?: number
          }
          await statisticsService.record({
            connectionId,
            participantId: data.participantId,
            bytesUploaded: BigInt(data.bytesUploaded),
            bytesDownloaded: BigInt(data.bytesDownloaded),
            latencyMs: data.latencyMs,
          })
        } catch { /* skip malformed */ }
      }
    }
  }
}

export const cleanupWorker = new CleanupWorker()
