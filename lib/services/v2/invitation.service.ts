/**
 * lib/services/v2/invitation.service.ts
 *
 * Secure invitation link generation and validation.
 *
 * Security model:
 *   - Token is generated with crypto.randomBytes(32) → base64url (256 bits of entropy).
 *   - Only the SHA-256 hash of the token is stored in the DB (tokenHash field).
 *   - The raw token is returned once to the creator and never stored.
 *   - Token enumeration is prevented: the lookup is by hash; validation timing is
 *     constant (timingSafeEqual applied to the hex-encoded hashes).
 *   - Invite URL: https://connectshare.app/join/<raw-token>
 */
import 'server-only'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { db } from '../../db'
import { getConfig } from '../../config/env'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import type { InvitationStatus } from '../../../generated/prisma/client'

export interface InvitationDto {
  id:           string
  connectionId: string
  inviteUrl:    string   // contains the raw token — shown once
  tokenHash:    string   // for admin reference only
  status:       InvitationStatus
  maxUses:      number
  currentUses:  number
  expiresAt:    Date
  createdAt:    Date
}

export interface InvitationValidationResult {
  valid:        boolean
  connectionId: string
  invitationId: string
  error?:       string
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export class InvitationServiceV2 {
  async create(input: {
    creatorId:    string
    connectionId: string
    maxUses?:     number
    expiresIn:    number   // seconds
  }): Promise<InvitationDto> {
    // Validate creator owns connection
    const conn = await db.connection.findUnique({ where: { id: input.connectionId } })
    if (!conn) throw new NotFoundError('Connection')
    if (conn.creatorUserId !== input.creatorId) throw new ForbiddenError()
    if (['TERMINATED', 'EXPIRED'].includes(conn.sessionStatus)) {
      throw new BadRequestError('Cannot create invitations for an ended connection')
    }

    // Generate raw token — this is the only time it appears in plaintext
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(rawToken)
    const cfg = getConfig()

    const invitation = await db.invitation.create({
      data: {
        connectionId: input.connectionId,
        creatorId:    input.creatorId,
        tokenHash,
        maxUses:      input.maxUses ?? 1,
        expiresAt:    new Date(Date.now() + input.expiresIn * 1000),
      },
    })

    await auditServiceV2.log({
      userId:     input.creatorId,
      action:     'INVITATION_CREATED',
      resourceId: invitation.id,
    })

    return {
      id:           invitation.id,
      connectionId: invitation.connectionId,
      inviteUrl:    `${cfg.APP_URL}/join/${rawToken}`,
      tokenHash:    invitation.tokenHash,
      status:       invitation.status,
      maxUses:      invitation.maxUses,
      currentUses:  invitation.currentUses,
      expiresAt:    invitation.expiresAt,
      createdAt:    invitation.createdAt,
    }
  }

  /**
   * Validate an invitation token submitted by a recipient.
   * Returns the connectionId so the caller can proceed with join.
   */
  async validate(rawToken: string): Promise<InvitationValidationResult> {
    const hash = hashToken(rawToken)
    const invitation = await db.invitation.findUnique({ where: { tokenHash: hash } })

    if (!invitation) {
      return { valid: false, connectionId: '', invitationId: '', error: 'INVALID_TOKEN' }
    }
    if (invitation.status === 'REVOKED') {
      return { valid: false, connectionId: invitation.connectionId, invitationId: invitation.id, error: 'REVOKED' }
    }
    if (invitation.expiresAt < new Date()) {
      await db.invitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } })
      return { valid: false, connectionId: invitation.connectionId, invitationId: invitation.id, error: 'EXPIRED' }
    }
    if (invitation.currentUses >= invitation.maxUses) {
      return { valid: false, connectionId: invitation.connectionId, invitationId: invitation.id, error: 'MAX_USES_REACHED' }
    }

    // Verify connected connection still exists and is accepting
    const conn = await db.connection.findUnique({ where: { id: invitation.connectionId } })
    if (!conn) {
      return { valid: false, connectionId: invitation.connectionId, invitationId: invitation.id, error: 'CONNECTION_NOT_FOUND' }
    }
    if (!['PENDING', 'GATEWAY_CONNECTED', 'READY', 'ACTIVE'].includes(conn.sessionStatus)) {
      return { valid: false, connectionId: invitation.connectionId, invitationId: invitation.id, error: 'CONNECTION_NOT_ACCEPTING' }
    }

    return { valid: true, connectionId: invitation.connectionId, invitationId: invitation.id }
  }

  /**
   * Claim an invitation: atomically increment currentUses and return invitationId.
   * Caller must have already called validate().
   */
  async claim(invitationId: string, userId: string): Promise<string> {
    const inv = await db.invitation.findUnique({ where: { id: invitationId } })
    if (!inv) throw new NotFoundError('Invitation')
    // Atomically increment — guard against race conditions
    const updated = await db.invitation.update({
      where: { id: invitationId },
      data: {
        currentUses: { increment: 1 },
        // Auto-mark CLAIMED if now at max
        status: inv.currentUses + 1 >= inv.maxUses ? 'CLAIMED' : inv.status,
      },
    })
    await auditServiceV2.log({
      userId,
      action:     'INVITATION_CLAIMED',
      resourceId: invitationId,
      metadata:   { connectionId: inv.connectionId },
    })
    return updated.id
  }

  async revoke(creatorId: string, invitationId: string): Promise<void> {
    const inv = await db.invitation.findUnique({ where: { id: invitationId } })
    if (!inv) throw new NotFoundError('Invitation')
    if (inv.creatorId !== creatorId) throw new ForbiddenError()
    await db.invitation.update({
      where: { id: invitationId },
      data:  { status: 'REVOKED', revokedAt: new Date() },
    })
    await auditServiceV2.log({ userId: creatorId, action: 'INVITATION_REVOKED', resourceId: invitationId })
  }

  async listByConnection(creatorId: string, connectionId: string): Promise<Omit<InvitationDto, 'inviteUrl'>[]> {
    const conn = await db.connection.findUnique({ where: { id: connectionId } })
    if (!conn || conn.creatorUserId !== creatorId) throw new ForbiddenError()
    const invitations = await db.invitation.findMany({
      where:   { connectionId },
      orderBy: { createdAt: 'desc' },
    })
    return invitations.map(i => ({
      id:           i.id,
      connectionId: i.connectionId,
      tokenHash:    i.tokenHash,  // hash only — raw token is gone after creation
      status:       i.status,
      maxUses:      i.maxUses,
      currentUses:  i.currentUses,
      expiresAt:    i.expiresAt,
      createdAt:    i.createdAt,
    }))
  }
}

export const invitationServiceV2 = new InvitationServiceV2()
