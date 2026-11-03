/**
 * lib/services/v2/audit.service.ts
 * Append-only structured audit log. Never blocks callers.
 */
import 'server-only'
import { db } from '../../db'
import { logger } from '../../logger'
import type { AuditAction } from '../../../generated/prisma/client'

interface AuditEntry {
  userId?:    string | null
  action:     AuditAction
  resourceId?: string
  metadata?:  unknown
  ipAddress?: string
  userAgent?: string
}

export class AuditServiceV2 {
  async log(entry: AuditEntry): Promise<void> {
    try {
      await db.auditLog.create({
        data: {
          userId:     entry.userId ?? undefined,
          action:     entry.action,
          resourceId: entry.resourceId,
          metadata:   entry.metadata as never,
          ipAddress:  entry.ipAddress,
          userAgent:  entry.userAgent,
        },
      })
    } catch (err) {
      logger.warn({ err, action: entry.action }, 'audit:write-failed')
    }
  }
}

export const auditServiceV2 = new AuditServiceV2()
