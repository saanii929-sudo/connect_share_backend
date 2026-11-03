/**
 * lib/services/v2/statistics.service.ts
 * Per-connection and per-user usage statistics.
 */
import 'server-only'
import { db } from '../../db'
import { ForbiddenError, NotFoundError } from '../../errors'
import { auditServiceV2 } from './audit.service'

export interface ConnectionStatsDto {
  connectionId:        string
  totalBytesUploaded:  string   // BigInt → string
  totalBytesDownloaded: string
  avgDownloadSpeedBps:  number | null
  avgUploadSpeedBps:    number | null
  avgLatencyMs:         number | null
  participantStats: Array<{
    participantId:   string
    bytesUploaded:   string
    bytesDownloaded: string
    latencyMs:       number | null
  }>
  recordedAt: Date
}

export interface UserUsageDto {
  totalBytesUploaded:   string
  totalBytesDownloaded: string
  connectionCount:      number
}

export class StatisticsService {
  /**
   * Ingest a usage update from the relay / data-plane agent.
   * Called by POST /api/v1/connections/:id/statistics (internal agent) or
   * aggregated from gateway heartbeat.
   */
  async record(input: {
    connectionId:  string
    participantId?: string
    bytesUploaded:  bigint
    bytesDownloaded: bigint
    avgDownloadSpeedBps?: number
    avgUploadSpeedBps?:   number
    latencyMs?:           number
  }): Promise<void> {
    await db.usageStatistic.create({
      data: {
        connectionId:         input.connectionId,
        participantId:        input.participantId,
        bytesUploaded:        input.bytesUploaded,
        bytesDownloaded:      input.bytesDownloaded,
        averageDownloadSpeed: input.avgDownloadSpeedBps,
        averageUploadSpeed:   input.avgUploadSpeedBps,
        latencyMs:            input.latencyMs,
      },
    })
    await auditServiceV2.log({
      action:     'USAGE_RECORDED',
      resourceId: input.connectionId,
      metadata:   {
        participantId: input.participantId,
        up:   input.bytesUploaded.toString(),
        down: input.bytesDownloaded.toString(),
      },
    })
  }

  async getConnectionStats(
    requestingUserId: string,
    connectionId:     string,
  ): Promise<ConnectionStatsDto> {
    const conn = await db.connection.findUnique({ where: { id: connectionId } })
    if (!conn) throw new NotFoundError('Connection')
    if (conn.creatorUserId !== requestingUserId) {
      const p = await db.connectionParticipant.findFirst({
        where: { connectionId, userId: requestingUserId, approvalStatus: 'APPROVED' },
      })
      if (!p) throw new ForbiddenError()
    }

    const rows = await db.usageStatistic.findMany({
      where:   { connectionId },
      orderBy: { recordedAt: 'desc' },
    })

    const total = rows.reduce(
      (acc, r) => ({
        up:   acc.up   + r.bytesUploaded,
        down: acc.down + r.bytesDownloaded,
      }),
      { up: BigInt(0), down: BigInt(0) },
    )

    const avgDown = avg(rows.map(r => r.averageDownloadSpeed).filter(notNull))
    const avgUp   = avg(rows.map(r => r.averageUploadSpeed).filter(notNull))
    const avgLat  = avg(rows.map(r => r.latencyMs).filter(notNull))

    // Aggregate by participant
    const byParticipant = new Map<string, { up: bigint; down: bigint; lat: number[] }>()
    for (const r of rows) {
      if (!r.participantId) continue
      const entry = byParticipant.get(r.participantId) ?? { up: BigInt(0), down: BigInt(0), lat: [] }
      entry.up   += r.bytesUploaded
      entry.down += r.bytesDownloaded
      if (r.latencyMs != null) entry.lat.push(r.latencyMs)
      byParticipant.set(r.participantId, entry)
    }

    return {
      connectionId,
      totalBytesUploaded:   total.up.toString(),
      totalBytesDownloaded: total.down.toString(),
      avgDownloadSpeedBps:  avgDown,
      avgUploadSpeedBps:    avgUp,
      avgLatencyMs:         avgLat,
      participantStats: Array.from(byParticipant.entries()).map(([pid, s]) => ({
        participantId:   pid,
        bytesUploaded:   s.up.toString(),
        bytesDownloaded: s.down.toString(),
        latencyMs:       avg(s.lat),
      })),
      recordedAt: rows[0]?.recordedAt ?? new Date(),
    }
  }

  async getUserUsage(userId: string): Promise<UserUsageDto> {
    // Sum across all connections the user created or participated in
    const creatorRows = await db.usageStatistic.findMany({
      where: { connection: { creatorUserId: userId } },
    })
    const participantRows = await db.usageStatistic.findMany({
      where: { participantId: { in: await this.getUserParticipantIds(userId) } },
    })
    const all = [...creatorRows, ...participantRows]

    const total = all.reduce(
      (acc, r) => ({ up: acc.up + r.bytesUploaded, down: acc.down + r.bytesDownloaded }),
      { up: BigInt(0), down: BigInt(0) },
    )

    const connectionCount = await db.connection.count({
      where: {
        OR: [
          { creatorUserId: userId },
          { participants: { some: { userId } } },
        ],
      },
    })

    return {
      totalBytesUploaded:   total.up.toString(),
      totalBytesDownloaded: total.down.toString(),
      connectionCount,
    }
  }

  private async getUserParticipantIds(userId: string): Promise<string[]> {
    const ps = await db.connectionParticipant.findMany({
      where:  { userId },
      select: { id: true },
    })
    return ps.map(p => p.id)
  }
}

function avg(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && v !== undefined)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function notNull<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined
}

export const statisticsService = new StatisticsService()
