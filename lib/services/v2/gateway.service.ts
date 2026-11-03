/**
 * lib/services/v2/gateway.service.ts
 *
 * The gateway service coordinates the creator-side networking agent.
 *
 * The "gateway" is the creator's device (or the Linux host running the relay
 * agent) that has established an outbound authenticated WebSocket tunnel to
 * the relay server and is ready to forward recipient traffic through its own
 * internet connection.
 *
 * Lifecycle:
 *   1. POST /api/v1/network/gateway/register  → records gateway, returns relay token
 *   2. Creator's agent opens WebSocket to relay server using that token
 *   3. Relay verifies gateway can pass traffic (test pings)
 *   4. Relay calls POST /api/v1/network/gateway/verify internally
 *   5. Connection transitions GATEWAY_CONNECTED → READY
 *   6. POST /api/v1/network/gateway/heartbeat  → keeps gateway alive
 */
import 'server-only'
import { db } from '../../db'
import { redis, REDIS_KEYS } from '../../redis'
import { decryptPrivateKey, buildServerConfig } from '../../crypto/wireguard'
import { getConfig } from '../../config/env'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import { eventService } from './event.service'
import { connectionService } from './connection.service'
import { signAccessToken } from '../../crypto/tokens'

// TTL for the gateway-online Redis key (seconds).
// Heartbeats must arrive within this window or the gateway is marked offline.
const GATEWAY_TTL_S = 45

export interface GatewayRegistrationResult {
  // A short-lived JWT the relay server uses to auth this gateway connection
  gatewayToken: string
  // The wg-quick server config (plaintext) — write to wg0.conf on the Linux host
  serverConfig:  string
  relayUrl:      string
}

export class GatewayService {
  /**
   * Called when the creator's agent is ready to establish the outbound tunnel.
   * Returns the relay token + WireGuard server config.
   */
  async register(input: {
    creatorUserId:   string
    creatorDeviceId: string
    connectionId:    string
  }): Promise<GatewayRegistrationResult> {
    const cfg = getConfig()

    const conn = await db.connection.findUnique({
      where:   { id: input.connectionId },
      include: { tunnelSessions: true },
    })
    if (!conn) throw new NotFoundError('Connection')
    if (conn.creatorUserId !== input.creatorUserId) throw new ForbiddenError()
    if (conn.creatorDeviceId !== input.creatorDeviceId) throw new ForbiddenError()
    if (['TERMINATED', 'EXPIRED'].includes(conn.sessionStatus)) {
      throw new BadRequestError('Connection is ended')
    }

    // Transition to GATEWAY_CONNECTED
    await db.connection.update({
      where: { id: input.connectionId },
      data:  {
        sessionStatus: 'GATEWAY_CONNECTED',
        gatewayStatus: 'CONNECTED',
      },
    })

    // Mark gateway online in Redis with TTL
    await redis.set(REDIS_KEYS.gatewayOnline(input.connectionId), '1', 'EX', GATEWAY_TTL_S)
    await redis.set(REDIS_KEYS.connectionState(input.connectionId), 'GATEWAY_CONNECTED')

    // Issue a gateway token — this is a short-lived JWT the relay server
    // uses to authenticate this gateway's WebSocket connection.
    // Payload includes connectionId so the relay can look up routing info.
    const gatewayToken = await signAccessToken({
      sub:          input.creatorUserId,
      role:         'GATEWAY',
      deviceId:     input.creatorDeviceId,
      connectionId: input.connectionId,
    })

    // Build server WireGuard config (returns existing peer blocks too)
    const peers = await db.tunnelSession.findMany({
      where: { connectionId: input.connectionId, tunnelStatus: { in: ['ACTIVE', 'CONNECTING'] } },
    })
    const serverConfig = this.buildConfig(conn, peers.map(p => ({
      publicKey:  p.wgPeerPubKey ?? '',
      allowedIPs: '0.0.0.0/0',
    })))

    await eventService.emit(input.connectionId, 'GATEWAY_REGISTERED', {
      deviceId: input.creatorDeviceId,
    })
    await auditServiceV2.log({
      userId:     input.creatorUserId,
      action:     'CONNECTION_GATEWAY_REGISTERED',
      resourceId: input.connectionId,
    })

    return {
      gatewayToken,
      serverConfig,
      relayUrl: cfg.RELAY_URL,
    }
  }

  /**
   * Heartbeat — called by the creator's agent every ~15 s.
   * Refreshes the Redis TTL. Returns current connection status.
   */
  async heartbeat(input: {
    creatorUserId: string
    connectionId:  string
    bytesRx?:      number
    bytesTx?:      number
    latencyMs?:    number
  }): Promise<{ status: string; gatewayStatus: string }> {
    const conn = await db.connection.findUnique({
      where:  { id: input.connectionId },
      select: { creatorUserId: true, sessionStatus: true, gatewayStatus: true },
    })
    if (!conn) throw new NotFoundError('Connection')
    if (conn.creatorUserId !== input.creatorUserId) throw new ForbiddenError()

    // Refresh TTL
    await redis.set(REDIS_KEYS.gatewayOnline(input.connectionId), '1', 'EX', GATEWAY_TTL_S)
    await redis.set(REDIS_KEYS.gatewayHeartbeat(input.connectionId), Date.now().toString(), 'EX', GATEWAY_TTL_S)

    // Record usage if provided
    if (input.bytesRx != null || input.bytesTx != null) {
      await db.usageStatistic.create({
        data: {
          connectionId:   input.connectionId,
          bytesUploaded:  BigInt(input.bytesTx ?? 0),
          bytesDownloaded: BigInt(input.bytesRx ?? 0),
          latencyMs:      input.latencyMs,
        },
      }).catch(() => { /* non-critical */ })
    }

    return {
      status:        conn.sessionStatus,
      gatewayStatus: conn.gatewayStatus,
    }
  }

  /**
   * Called by the relay server after it has verified the gateway can forward
   * traffic. This is the gate before READY status.
   *
   * Authenticated via the RELAY_AUTH_SECRET shared secret in the header.
   */
  async verifyGateway(input: {
    connectionId: string
    relayAuthHeader: string
  }): Promise<void> {
    const cfg = getConfig()
    if (cfg.RELAY_AUTH_SECRET && input.relayAuthHeader !== `Bearer ${cfg.RELAY_AUTH_SECRET}`) {
      throw new UnauthorizedError('Invalid relay auth')
    }
    await connectionService.markReady(input.connectionId)
    await auditServiceV2.log({
      action:     'CONNECTION_GATEWAY_VERIFIED',
      resourceId: input.connectionId,
    })
  }

  /**
   * Mark gateway as failed (called by relay on disconnect/timeout).
   */
  async markFailed(connectionId: string, reason?: string): Promise<void> {
    await db.connection.update({
      where: { id: connectionId },
      data:  { gatewayStatus: 'FAILED' },
    })
    await redis.del(REDIS_KEYS.gatewayOnline(connectionId))
    await eventService.emit(connectionId, 'GATEWAY_FAILED', { reason })
    await auditServiceV2.log({ action: 'CONNECTION_GATEWAY_VERIFIED', resourceId: connectionId, metadata: { failed: true, reason } })
  }

  /**
   * Return the decrypted server WireGuard config (creator's host writes this to wg0.conf).
   */
  async getServerConfig(creatorUserId: string, connectionId: string): Promise<string> {
    const conn = await db.connection.findUnique({
      where: { id: connectionId },
    })
    if (!conn) throw new NotFoundError('Connection')
    if (conn.creatorUserId !== creatorUserId) throw new ForbiddenError()
    if (!conn.wgServerPrivKey) throw new BadRequestError('Server key not provisioned')

    const peers = await db.tunnelSession.findMany({
      where: { connectionId, wgPeerPubKey: { not: null } },
    })
    return this.buildConfig(conn, peers.map(p => ({
      publicKey:  p.wgPeerPubKey!,
      allowedIPs: `${p.wgPeerAddress ?? '10.8.0.2'}/32`,
    })))
  }

  private buildConfig(
    conn: { wgServerPrivKey: string | null; wgServerAddress: string | null; wgListenPort: number | null },
    peers: Array<{ publicKey: string; allowedIPs: string }>,
  ): string {
    if (!conn.wgServerPrivKey) return ''
    return buildServerConfig({
      privateKey:  decryptPrivateKey(conn.wgServerPrivKey),
      address:     conn.wgServerAddress ?? '10.8.0.1/24',
      listenPort:  conn.wgListenPort ?? 51820,
      peers,
    })
  }
}

export const gatewayService = new GatewayService()
