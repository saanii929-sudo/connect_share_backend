/**
 * lib/services/v2/participant.service.ts
 *
 * Handles the recipient join flow:
 *   1. Recipient validates invite token → gets connectionId
 *   2. Recipient joins → ConnectionParticipant created (PENDING_APPROVAL)
 *   3. Creator is notified (via Redis pub/sub)
 *   4. Creator approves/rejects
 *   5. On approval → TunnelSessionService provisions the tunnel
 *   6. Once tunnel verifies → connectionStatus = CONNECTED, routing activated
 */
import 'server-only'
import { db } from '../../db'
import { redis, REDIS_KEYS } from '../../redis'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import { eventService } from './event.service'
import type {
  ParticipantConnectionStatus,
  ApprovalStatus,
  ParticipantRole,
} from '../../../generated/prisma/client'

export interface ParticipantDto {
  id:               string
  connectionId:     string
  userId:           string
  deviceId:         string
  participantRole:  ParticipantRole
  approvalStatus:   ApprovalStatus
  connectionStatus: ParticipantConnectionStatus
  joinedAt:         Date | null
  disconnectedAt:   Date | null
  createdAt:        Date
}

function toDto(p: {
  id: string; connectionId: string; userId: string; deviceId: string
  participantRole: ParticipantRole; approvalStatus: ApprovalStatus
  connectionStatus: ParticipantConnectionStatus
  joinedAt: Date | null; disconnectedAt: Date | null; createdAt: Date
}): ParticipantDto {
  return {
    id:               p.id,
    connectionId:     p.connectionId,
    userId:           p.userId,
    deviceId:         p.deviceId,
    participantRole:  p.participantRole,
    approvalStatus:   p.approvalStatus,
    connectionStatus: p.connectionStatus,
    joinedAt:         p.joinedAt,
    disconnectedAt:   p.disconnectedAt,
    createdAt:        p.createdAt,
  }
}

export class ParticipantService {
  /**
   * Recipient submits an invite link → creates a pending join request.
   * Returns the participantId the recipient must poll for approval status.
   */
  async join(input: {
    userId:       string
    deviceId:     string
    invitationId: string
    connectionId: string
  }): Promise<{ participantId: string }> {
    // Verify device belongs to user
    const device = await db.device.findUnique({ where: { id: input.deviceId } })
    if (!device) throw new NotFoundError('Device')
    if (device.userId !== input.userId) throw new ForbiddenError()
    if (device.deviceStatus === 'REVOKED') throw new BadRequestError('Device is revoked')

    // Verify connection is still accepting
    const conn = await db.connection.findUnique({ where: { id: input.connectionId } })
    if (!conn) throw new NotFoundError('Connection')
    if (!['PENDING', 'GATEWAY_CONNECTED', 'READY', 'ACTIVE'].includes(conn.sessionStatus)) {
      throw new BadRequestError(`Connection is not accepting participants (status: ${conn.sessionStatus})`)
    }

    // Creator cannot join their own connection as recipient
    if (conn.creatorUserId === input.userId) {
      throw new BadRequestError('Creator cannot join their own connection as a recipient')
    }

    // Idempotent — if already exists return existing
    const existing = await db.connectionParticipant.findUnique({
      where: { connectionId_userId: { connectionId: input.connectionId, userId: input.userId } },
    })
    if (existing) {
      if (existing.approvalStatus === 'REJECTED' || existing.approvalStatus === 'REVOKED') {
        throw new BadRequestError(`Your request was already ${existing.approvalStatus}`)
      }
      return { participantId: existing.id }
    }

    // Check max recipients
    const approved = await db.connectionParticipant.count({
      where: { connectionId: input.connectionId, approvalStatus: 'APPROVED', participantRole: 'RECIPIENT' },
    })
    if (approved >= conn.maxRecipients) {
      throw new BadRequestError('Connection has reached maximum recipient capacity')
    }

    const participant = await db.connectionParticipant.create({
      data: {
        connectionId:    input.connectionId,
        userId:          input.userId,
        deviceId:        input.deviceId,
        invitationId:    input.invitationId,
        participantRole: 'RECIPIENT',
      },
    })

    // Notify creator
    await eventService.emitToCreator(input.connectionId, 'JOIN_REQUESTED', {
      participantId: participant.id,
      userId:        input.userId,
      deviceId:      input.deviceId,
    })
    await auditServiceV2.log({
      userId:     input.userId,
      action:     'JOIN_REQUESTED',
      resourceId: participant.id,
      metadata:   { connectionId: input.connectionId },
    })

    return { participantId: participant.id }
  }

  async approve(
    creatorUserId: string,
    participantId: string,
  ): Promise<ParticipantDto> {
    const participant = await this.assertCreatorAccess(creatorUserId, participantId)
    if (participant.approvalStatus !== 'PENDING') {
      throw new BadRequestError(`Participant is already ${participant.approvalStatus}`)
    }

    const updated = await db.connectionParticipant.update({
      where: { id: participantId },
      data:  {
        approvalStatus:   'APPROVED',
        connectionStatus: 'APPROVED',
      },
    })

    await eventService.emitToParticipant(participantId, 'PARTICIPANT_APPROVED', {
      participantId,
      connectionId: participant.connectionId,
    })
    await eventService.emit(participant.connectionId, 'PARTICIPANT_APPROVED', { participantId })
    await auditServiceV2.log({
      userId:     creatorUserId,
      action:     'PARTICIPANT_APPROVED',
      resourceId: participantId,
    })

    return toDto(updated)
  }

  async reject(
    creatorUserId: string,
    participantId: string,
    reason?: string,
  ): Promise<ParticipantDto> {
    const participant = await this.assertCreatorAccess(creatorUserId, participantId)
    if (participant.approvalStatus !== 'PENDING') {
      throw new BadRequestError(`Participant is already ${participant.approvalStatus}`)
    }

    const updated = await db.connectionParticipant.update({
      where: { id: participantId },
      data:  { approvalStatus: 'REJECTED', connectionStatus: 'REJECTED' },
    })

    await eventService.emitToParticipant(participantId, 'PARTICIPANT_REJECTED', { reason })
    await auditServiceV2.log({ userId: creatorUserId, action: 'PARTICIPANT_REJECTED', resourceId: participantId })

    return toDto(updated)
  }

  async revoke(
    creatorUserId: string,
    participantId: string,
  ): Promise<ParticipantDto> {
    const participant = await this.assertCreatorAccess(creatorUserId, participantId)
    if (!['APPROVED', 'TUNNEL_PROVISIONED', 'TUNNEL_CONNECTING', 'CONNECTED'].includes(participant.approvalStatus)) {
      throw new BadRequestError('Cannot revoke a participant who is not approved')
    }

    const updated = await db.connectionParticipant.update({
      where: { id: participantId },
      data:  { approvalStatus: 'REVOKED', connectionStatus: 'REVOKED', disconnectedAt: new Date() },
    })

    await redis.del(REDIS_KEYS.participantStatus(participantId))
    await eventService.emitToParticipant(participantId, 'PARTICIPANT_REVOKED', {})
    await eventService.emit(participant.connectionId, 'PARTICIPANT_REVOKED', { participantId })
    await auditServiceV2.log({ userId: creatorUserId, action: 'PARTICIPANT_REVOKED', resourceId: participantId })

    return toDto(updated)
  }

  async leave(userId: string, participantId: string): Promise<void> {
    const participant = await db.connectionParticipant.findUnique({ where: { id: participantId } })
    if (!participant) throw new NotFoundError('Participant')
    if (participant.userId !== userId) throw new ForbiddenError()

    await db.connectionParticipant.update({
      where: { id: participantId },
      data:  { connectionStatus: 'DISCONNECTED', disconnectedAt: new Date() },
    })

    await redis.del(REDIS_KEYS.participantStatus(participantId))
    await eventService.emitToCreator(participant.connectionId, 'PARTICIPANT_LEFT', { participantId, userId })
    await auditServiceV2.log({ userId, action: 'PARTICIPANT_LEFT', resourceId: participantId })
  }

  async getStatus(userId: string, participantId: string): Promise<ParticipantDto> {
    const participant = await db.connectionParticipant.findUnique({ where: { id: participantId } })
    if (!participant) throw new NotFoundError('Participant')
    if (participant.userId !== userId) throw new ForbiddenError()
    return toDto(participant)
  }

  async listPending(creatorUserId: string, connectionId: string): Promise<ParticipantDto[]> {
    const conn = await db.connection.findUnique({ where: { id: connectionId } })
    if (!conn || conn.creatorUserId !== creatorUserId) throw new ForbiddenError()
    const participants = await db.connectionParticipant.findMany({
      where:   { connectionId, approvalStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })
    return participants.map(toDto)
  }

  async updateConnectionStatus(
    participantId: string,
    status: ParticipantConnectionStatus,
  ): Promise<void> {
    await db.connectionParticipant.update({
      where: { id: participantId },
      data:  {
        connectionStatus: status,
        ...(status === 'CONNECTED'     ? { joinedAt: new Date() }          : {}),
        ...(status === 'DISCONNECTED'  ? { disconnectedAt: new Date() }    : {}),
      },
    })
    await redis.set(REDIS_KEYS.participantStatus(participantId), status, 'EX', 3600)
  }

  private async assertCreatorAccess(creatorUserId: string, participantId: string) {
    const participant = await db.connectionParticipant.findUnique({
      where:   { id: participantId },
      include: { connection: { select: { creatorUserId: true } } },
    })
    if (!participant) throw new NotFoundError('Participant')
    if (participant.connection.creatorUserId !== creatorUserId) throw new ForbiddenError()
    return participant
  }
}

export const participantService = new ParticipantService()
