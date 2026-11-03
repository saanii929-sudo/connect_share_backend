/**
 * lib/services/v2/connection.service.ts
 *
 * Manages the full lifecycle of sharing connections (the v2 spec calls them
 * "connections" where v1 called them "sessions").
 *
 * Key lifecycle transitions:
 *   PENDING → GATEWAY_CONNECTED (creator's gateway registers)
 *   GATEWAY_CONNECTED → READY (relay verifies gateway can forward traffic)
 *   READY → ACTIVE (first recipient fully connects)
 *   ACTIVE|READY|PAUSED → TERMINATED (creator stops)
 *   ACTIVE|READY → PAUSED (creator pauses)
 *   any live → EXPIRED (TTL elapsed)
 *
 * A connection must NOT reach ACTIVE until the relay has verified
 * that traffic-forwarding through the gateway works.
 */
import 'server-only'
import { randomBytes } from 'crypto'
import { db } from '../../db'
import { redis, REDIS_KEYS } from '../../redis'
import {
  generateWgKeypair,
  serverAddressFromSubnet,
  encryptPrivateKey,
} from '../../crypto/wireguard'
import { getConfig } from '../../config/env'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import { eventService } from './event.service'
import { revocationService } from './revocation.service'
import type {
  ConnectionStatus,
  GatewayStatus,
} from '../../../generated/prisma/client'

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface ConnectionDto {
  id:              string
  creatorUserId:   string
  creatorDeviceId: string
  title:           string | null
  sessionStatus:   ConnectionStatus
  gatewayStatus:   GatewayStatus
  maxRecipients:   number
  wgEndpoint:      string | null
  wgListenPort:    number | null
  expiresAt:       Date
  createdAt:       Date
  disconnectedAt:  Date | null
}

function toDto(c: {
  id: string; creatorUserId: string; creatorDeviceId: string
  title: string | null; sessionStatus: ConnectionStatus
  gatewayStatus: GatewayStatus; maxRecipients: number
  wgEndpoint: string | null; wgListenPort: number | null
  expiresAt: Date; createdAt: Date; disconnectedAt: Date | null
}): ConnectionDto {
  return {
    id:              c.id,
    creatorUserId:   c.creatorUserId,
    creatorDeviceId: c.creatorDeviceId,
    title:           c.title,
    sessionStatus:   c.sessionStatus,
    gatewayStatus:   c.gatewayStatus,
    maxRecipients:   c.maxRecipients,
    wgEndpoint:      c.wgEndpoint,
    wgListenPort:    c.wgListenPort,
    expiresAt:       c.expiresAt,
    createdAt:       c.createdAt,
    disconnectedAt:  c.disconnectedAt,
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ConnectionService {
  /**
   * Step 1 of creator workflow: create the connection record.
   * Provisions WireGuard keys immediately so the gateway can receive config.
   */
  async create(input: {
    creatorUserId:   string
    creatorDeviceId: string
    title?:          string
    maxRecipients?:  number
    expiresIn:       number    // seconds
    endpoint:        string    // "host:port" — where the relay/server listens
    maxBytesTotal?:  number    // hard cap on total bytes transferred
    bandwidthLimitBps?: number // bytes/sec per tunnel
  }): Promise<ConnectionDto> {
    const cfg = getConfig()

    // Verify device belongs to creator and is ACTIVE
    const device = await db.device.findUnique({ where: { id: input.creatorDeviceId } })
    if (!device) throw new NotFoundError('Device')
    if (device.userId !== input.creatorUserId) throw new ForbiddenError()
    if (device.deviceStatus === 'REVOKED') throw new BadRequestError('Device is revoked')

    const keypair    = generateWgKeypair()
    const serverAddr = serverAddressFromSubnet(cfg.WG_BASE_SUBNET)

    // Generate an ephemeral relay session key (encrypted) for relay-to-API auth
    const relaySessionKeyPlain = randomBytes(32).toString('base64url')
    const relaySessionKeyEnc   = encryptPrivateKey(relaySessionKeyPlain)

    const connection = await db.connection.create({
      data: {
        creatorUserId:   input.creatorUserId,
        creatorDeviceId: input.creatorDeviceId,
        title:           input.title,
        maxRecipients:   input.maxRecipients ?? 5,
        maxBytesTotal:   input.maxBytesTotal != null ? BigInt(input.maxBytesTotal) : null,
        bandwidthLimitBps: input.bandwidthLimitBps ?? null,
        wgServerPubKey:  keypair.publicKey,
        wgServerPrivKey: encryptPrivateKey(keypair.privateKey),
        wgServerAddress: serverAddr,
        wgListenPort:    cfg.WG_SERVER_LISTEN_PORT,
        wgEndpoint:      input.endpoint,
        relaySessionKey: relaySessionKeyEnc,
        expiresAt:       new Date(Date.now() + input.expiresIn * 1000),
      },
    })

    // Add creator as CREATOR participant
    await db.connectionParticipant.create({
      data: {
        connectionId:    connection.id,
        userId:          input.creatorUserId,
        deviceId:        input.creatorDeviceId,
        participantRole: 'CREATOR',
        approvalStatus:  'APPROVED',
        connectionStatus:'PENDING_APPROVAL',
      },
    })

    await auditServiceV2.log({
      userId:     input.creatorUserId,
      action:     'CONNECTION_CREATED',
      resourceId: connection.id,
    })
    await eventService.emit(connection.id, 'GATEWAY_REGISTERED', {
      note: 'Connection created, awaiting gateway registration',
    })

    return toDto(connection)
  }

  async getById(connectionId: string, requestingUserId: string): Promise<ConnectionDto> {
    const conn = await db.connection.findUnique({ where: { id: connectionId } })
    if (!conn) throw new NotFoundError('Connection')
    // Creator or any approved participant may view
    if (conn.creatorUserId !== requestingUserId) {
      const participant = await db.connectionParticipant.findFirst({
        where: {
          connectionId,
          userId:         requestingUserId,
          approvalStatus: 'APPROVED',
        },
      })
      if (!participant) throw new ForbiddenError()
    }
    return toDto(conn)
  }

  async listByCreator(creatorUserId: string): Promise<ConnectionDto[]> {
    const conns = await db.connection.findMany({
      where:   { creatorUserId },
      orderBy: { createdAt: 'desc' },
    })
    return conns.map(toDto)
  }

  async listHistory(userId: string): Promise<ConnectionDto[]> {
    // All connections where user was creator or participant, ended
    const asCreator = await db.connection.findMany({
      where: {
        creatorUserId: userId,
        sessionStatus: { in: ['TERMINATED', 'EXPIRED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const asParticipant = await db.connectionParticipant.findMany({
      where: {
        userId,
        participantRole: 'RECIPIENT',
        connection: { sessionStatus: { in: ['TERMINATED', 'EXPIRED'] } },
      },
      include: { connection: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const participantConns = asParticipant.map(p => toDto(p.connection))
    const combined = [...asCreator.map(toDto), ...participantConns]
    combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return combined.slice(0, 100)
  }

  /**
   * Creator pauses an active connection (halts new traffic routing).
   */
  async pause(creatorUserId: string, connectionId: string): Promise<ConnectionDto> {
    const conn = await this.assertOwned(creatorUserId, connectionId)
    if (!['ACTIVE', 'READY'].includes(conn.sessionStatus)) {
      throw new BadRequestError(`Cannot pause a connection in status ${conn.sessionStatus}`)
    }
    const updated = await db.connection.update({
      where: { id: connectionId },
      data:  { sessionStatus: 'PAUSED' },
    })
    await redis.set(REDIS_KEYS.connectionState(connectionId), 'PAUSED')
    await eventService.emit(connectionId, 'CONNECTION_PAUSED')
    await auditServiceV2.log({ userId: creatorUserId, action: 'CONNECTION_PAUSED', resourceId: connectionId })
    return toDto(updated)
  }

  /**
   * Creator stops a connection entirely.
   */
  async terminate(creatorUserId: string, connectionId: string): Promise<ConnectionDto> {
    const conn = await this.assertOwned(creatorUserId, connectionId)
    if (['TERMINATED', 'EXPIRED'].includes(conn.sessionStatus)) {
      throw new BadRequestError('Connection is already ended')
    }
    const updated = await db.connection.update({
      where: { id: connectionId },
      data:  { sessionStatus: 'TERMINATED', disconnectedAt: new Date() },
    })
    await redis.del(REDIS_KEYS.connectionState(connectionId))
    await redis.del(REDIS_KEYS.gatewayOnline(connectionId))
    // Immediate revocation broadcast — relay drops all tunnels + gateway
    await revocationService.revokeConnection({ connectionId })
    await eventService.emit(connectionId, 'CONNECTION_TERMINATED')
    await auditServiceV2.log({ userId: creatorUserId, action: 'CONNECTION_TERMINATED', resourceId: connectionId })
    return toDto(updated)
  }

  /**
   * Mark connection READY after relay gateway verification succeeds.
   * Called internally by GatewayService once verification passes.
   */
  async markReady(connectionId: string): Promise<void> {
    await db.connection.update({
      where: { id: connectionId },
      data:  {
        sessionStatus: 'READY',
        gatewayStatus: 'VERIFIED',
      },
    })
    await redis.set(REDIS_KEYS.connectionState(connectionId), 'READY')
    await eventService.emit(connectionId, 'CONNECTION_READY')
    await auditServiceV2.log({ action: 'CONNECTION_READY', resourceId: connectionId })
  }

  /**
   * Transition READY/PAUSED → ACTIVE once a recipient tunnel is confirmed up.
   */
  async maybeActivate(connectionId: string): Promise<void> {
    const conn = await db.connection.findUnique({ where: { id: connectionId } })
    if (!conn || !['READY', 'PAUSED'].includes(conn.sessionStatus)) return
    await db.connection.update({
      where: { id: connectionId },
      data:  { sessionStatus: 'ACTIVE' },
    })
    await redis.set(REDIS_KEYS.connectionState(connectionId), 'ACTIVE')
    await eventService.emit(connectionId, 'CONNECTION_ACTIVATED')
    await auditServiceV2.log({ action: 'CONNECTION_ACTIVATED', resourceId: connectionId })
  }

  /**
   * Batch-expire connections past their expiresAt.
   */
  async expireStale(): Promise<number> {
    const result = await db.connection.updateMany({
      where: {
        sessionStatus: { in: ['PENDING', 'GATEWAY_CONNECTED', 'READY', 'ACTIVE', 'PAUSED'] },
        expiresAt:     { lte: new Date() },
      },
      data: { sessionStatus: 'EXPIRED', disconnectedAt: new Date() },
    })
    return result.count
  }

  private async assertOwned(userId: string, connectionId: string) {
    const conn = await db.connection.findUnique({ where: { id: connectionId } })
    if (!conn) throw new NotFoundError('Connection')
    if (conn.creatorUserId !== userId) throw new ForbiddenError()
    return conn
  }
}

export const connectionService = new ConnectionService()
