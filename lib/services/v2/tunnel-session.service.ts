/**
 * lib/services/v2/tunnel-session.service.ts
 *
 * Provisions and manages per-recipient tunnel sessions.
 *
 * After the creator approves a participant:
 *   1. Generate a unique tunnelIdentifier (opaque, used by relay to route packets)
 *   2. Generate WireGuard peer keypair for this recipient
 *   3. Store encrypted private key, public key, and assigned IP
 *   4. Return the peer config ONCE to the recipient (private key plaintext)
 *   5. Notify the relay to expect this tunnel
 *
 * Verification flow (relay-driven):
 *   1. Relay receives encrypted packets from the recipient peer
 *   2. Relay decrypts and test-pings a known host via the gateway
 *   3. If 3 consecutive pings succeed → relay calls POST /network/tunnel/verify
 *   4. Backend marks tunnel ACTIVE, marks participant CONNECTED
 *   5. Connection transitions to ACTIVE if not already
 */
import 'server-only'
import { randomBytes } from 'crypto'
import { db } from '../../db'
import { redis, REDIS_KEYS } from '../../redis'
import {
  generateWgKeypair,
  allocatePeerAddress,
  encryptPrivateKey,
  buildPeerConfig,
} from '../../crypto/wireguard'
import { getConfig } from '../../config/env'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import { eventService } from './event.service'
import { participantService } from './participant.service'
import { connectionService } from './connection.service'
import type { TunnelStatus } from '../../../generated/prisma/client'

export interface TunnelProvisionResult {
  tunnelId:    string
  peerConfig:  string   // wg-quick .conf text — shown ONCE, never stored in plain
  tunnelToken: string   // token the recipient sends to the relay to identify their tunnel
}

export interface TunnelStatusDto {
  tunnelId:         string
  tunnelIdentifier: string
  tunnelStatus:     TunnelStatus
  lastHandshakeAt:  Date | null
  createdAt:        Date
}

export class TunnelSessionService {
  /**
   * Provision a tunnel for an approved participant.
   * Called automatically after creator approves.
   */
  async provision(input: {
    participantId: string
    connectionId:  string
    deviceId:      string
  }): Promise<TunnelProvisionResult> {
    const cfg = getConfig()

    // Verify participant exists and is approved
    const participant = await db.connectionParticipant.findUnique({
      where: { id: input.participantId },
    })
    if (!participant) throw new NotFoundError('Participant')
    if (participant.approvalStatus !== 'APPROVED') {
      throw new BadRequestError('Participant is not approved')
    }

    // Idempotent — return existing tunnel if already provisioned
    const existing = await db.tunnelSession.findUnique({
      where: { participantId: input.participantId },
    })
    if (existing) {
      // Already provisioned — we cannot re-issue the private key,
      // but we can re-issue the tunnel token for reconnection
      const tunnelToken = this.issueTunnelToken(existing.tunnelIdentifier)
      return {
        tunnelId:    existing.id,
        peerConfig:  '', // private key gone — client must reconnect with existing keys
        tunnelToken,
      }
    }

    // Assign the next available IP slot
    const existingCount = await db.tunnelSession.count({ where: { connectionId: input.connectionId } })
    const peerAddress   = allocatePeerAddress(cfg.WG_BASE_SUBNET, existingCount)

    // Get server public key
    const conn = await db.connection.findUnique({
      where:  { id: input.connectionId },
      select: { wgServerPubKey: true, wgEndpoint: true, wgListenPort: true },
    })
    if (!conn) throw new NotFoundError('Connection')

    // Generate peer keypair
    const keypair         = generateWgKeypair()
    const tunnelIdentifier = randomBytes(24).toString('base64url')

    const tunnel = await db.tunnelSession.create({
      data: {
        connectionId:      input.connectionId,
        participantId:     input.participantId,
        deviceId:          input.deviceId,
        tunnelIdentifier,
        tunnelStatus:      'INITIALIZING',
        wgPeerPubKey:      keypair.publicKey,
        wgPeerPrivKey:     encryptPrivateKey(keypair.privateKey),
        wgPeerAddress:     peerAddress,
      },
    })

    // Update participant status
    await participantService.updateConnectionStatus(input.participantId, 'TUNNEL_PROVISIONED')

    // Build the peer config with the plaintext private key — this is the ONLY time it appears
    const peerConfig = buildPeerConfig({
      privateKey:      keypair.privateKey,
      address:         peerAddress,
      serverPublicKey: conn.wgServerPubKey ?? '',
      serverEndpoint:  conn.wgEndpoint ?? '',
    })

    const tunnelToken = this.issueTunnelToken(tunnelIdentifier)

    // Notify relay of the new expected peer
    await redis.publish(
      REDIS_KEYS.gatewayChannel(input.connectionId),
      JSON.stringify({
        type:             'TUNNEL_PROVISIONED',
        tunnelIdentifier,
        participantId:    input.participantId,
        peerPubKey:       keypair.publicKey,
        peerAddress,
      }),
    )

    await eventService.emitToParticipant(input.participantId, 'TUNNEL_PROVISIONED', {
      tunnelId:    tunnel.id,
      peerAddress,
    })
    await eventService.emit(input.connectionId, 'TUNNEL_PROVISIONED', {
      tunnelId:      tunnel.id,
      participantId: input.participantId,
    })
    await auditServiceV2.log({
      action:     'TUNNEL_PROVISIONED',
      resourceId: tunnel.id,
      metadata:   { participantId: input.participantId, peerAddress },
    })

    return { tunnelId: tunnel.id, peerConfig, tunnelToken }
  }

  /**
   * Relay calls this when the tunnel has passed verification.
   */
  async markEstablished(input: {
    tunnelIdentifier: string
    relayAuthHeader:  string
  }): Promise<void> {
    const cfg = getConfig()
    if (cfg.RELAY_AUTH_SECRET && input.relayAuthHeader !== `Bearer ${cfg.RELAY_AUTH_SECRET}`) {
      throw new UnauthorizedError('Invalid relay auth')
    }

    const tunnel = await db.tunnelSession.findUnique({
      where: { tunnelIdentifier: input.tunnelIdentifier },
    })
    if (!tunnel) throw new NotFoundError('TunnelSession')

    await db.tunnelSession.update({
      where: { id: tunnel.id },
      data:  { tunnelStatus: 'ACTIVE' },
    })

    await redis.set(REDIS_KEYS.tunnelOnline(tunnel.tunnelIdentifier), '1', 'EX', 60)
    await participantService.updateConnectionStatus(tunnel.participantId, 'CONNECTED')

    // Activate routing on the connection (idempotent)
    await connectionService.maybeActivate(tunnel.connectionId)

    await eventService.emitToParticipant(tunnel.participantId, 'TUNNEL_ESTABLISHED', {
      tunnelId: tunnel.id,
    })
    await eventService.emit(tunnel.connectionId, 'ROUTING_ACTIVATED', {
      tunnelId:      tunnel.id,
      participantId: tunnel.participantId,
    })
    await auditServiceV2.log({ action: 'TUNNEL_ESTABLISHED', resourceId: tunnel.id })
  }

  async terminate(
    requestingUserId: string,
    tunnelId: string,
  ): Promise<void> {
    const tunnel = await db.tunnelSession.findUnique({
      where:   { id: tunnelId },
      include: { connection: { select: { creatorUserId: true } } },
    })
    if (!tunnel) throw new NotFoundError('TunnelSession')
    // Creator or the participant themselves may terminate
    const isCreator = tunnel.connection.creatorUserId === requestingUserId
    const participant = await db.connectionParticipant.findUnique({ where: { id: tunnel.participantId } })
    const isParticipant = participant?.userId === requestingUserId
    if (!isCreator && !isParticipant) throw new ForbiddenError()

    await db.tunnelSession.update({
      where: { id: tunnelId },
      data:  { tunnelStatus: 'TERMINATED' },
    })
    await redis.del(REDIS_KEYS.tunnelOnline(tunnel.tunnelIdentifier))

    // Notify relay to drop the tunnel
    await redis.publish(
      REDIS_KEYS.gatewayChannel(tunnel.connectionId),
      JSON.stringify({ type: 'TUNNEL_TERMINATED', tunnelIdentifier: tunnel.tunnelIdentifier }),
    )

    await eventService.emit(tunnel.connectionId, 'TUNNEL_TERMINATED', {
      tunnelId, participantId: tunnel.participantId,
    })
    await auditServiceV2.log({ action: 'TUNNEL_TERMINATED', resourceId: tunnelId })
  }

  async getStatus(requestingUserId: string, tunnelId: string): Promise<TunnelStatusDto> {
    const tunnel = await db.tunnelSession.findUnique({
      where:   { id: tunnelId },
      include: {
        connection:  { select: { creatorUserId: true } },
        participant: { select: { userId: true } },
      },
    })
    if (!tunnel) throw new NotFoundError('TunnelSession')
    const isCreator     = tunnel.connection.creatorUserId === requestingUserId
    const isParticipant = tunnel.participant.userId === requestingUserId
    if (!isCreator && !isParticipant) throw new ForbiddenError()
    return {
      tunnelId:         tunnel.id,
      tunnelIdentifier: tunnel.tunnelIdentifier,
      tunnelStatus:     tunnel.tunnelStatus,
      lastHandshakeAt:  tunnel.lastHandshakeAt,
      createdAt:        tunnel.createdAt,
    }
  }

  /** Opaque token the client sends to the relay to claim a tunnel slot */
  private issueTunnelToken(tunnelIdentifier: string): string {
    // Simple HMAC-signed token embedding the identifier
    const { createHmac } = require('crypto')
    const secret = process.env.RELAY_AUTH_SECRET ?? 'default-tunnel-token-secret'
    const sig = createHmac('sha256', secret).update(tunnelIdentifier).digest('base64url')
    return `${Buffer.from(tunnelIdentifier).toString('base64url')}.${sig}`
  }
}

export const tunnelSessionService = new TunnelSessionService()
