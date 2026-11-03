/**
 * lib/services/v2/revocation.service.ts
 *
 * Immediate access revocation. When a session/participant/device is revoked,
 * this service broadcasts a real-time revocation command to:
 *   1. The realtime WebSocket hub (via Redis pub/sub) → notifies clients
 *   2. The relay server (via Redis pub/sub on the gateway channel) → drops
 *      the active tunnel/gateway connection immediately
 *
 * This ensures revocation takes effect within seconds, not at the next poll.
 */
import 'server-only'
import { redis, REDIS_KEYS } from '../../redis'
import { logger } from '../../logger'

export class RevocationService {
  /**
   * Revoke a participant's tunnel access immediately.
   * The relay will close the tunnel WebSocket and stop forwarding packets.
   */
  async revokeParticipant(input: {
    connectionId:   string
    participantId:   string
    tunnelIdentifier?: string
  }): Promise<void> {
    // Notify relay to drop the tunnel
    if (input.tunnelIdentifier) {
      await redis.publish(
        REDIS_KEYS.gatewayChannel(input.connectionId),
        JSON.stringify({
          type:              'REVOKE_TUNNEL',
          tunnelIdentifier:  input.tunnelIdentifier,
          participantId:     input.participantId,
          connectionId:      input.connectionId,
          ts:                Date.now(),
        }),
      )
    }

    // Notify the participant and session subscribers
    await redis.publish(
      REDIS_KEYS.participantChannel(input.participantId),
      JSON.stringify({
        type: 'connection:participant_revoked',
        participantId: input.participantId,
        connectionId:  input.connectionId,
      }),
    )
    await redis.publish(
      REDIS_KEYS.sessionChannel(input.connectionId),
      JSON.stringify({
        type: 'connection:participant_revoked',
        participantId: input.participantId,
        connectionId:  input.connectionId,
      }),
    )

    logger.info(
      { connectionId: input.connectionId, participantId: input.participantId },
      'revocation:participant-revoked',
    )
  }

  /**
   * Revoke an entire connection (terminate all tunnels + gateway).
   */
  async revokeConnection(input: {
    connectionId: string
  }): Promise<void> {
    // Drop the gateway
    await redis.publish(
      REDIS_KEYS.gatewayChannel(input.connectionId),
      JSON.stringify({
        type: 'REVOKE_GATEWAY',
        connectionId: input.connectionId,
        ts: Date.now(),
      }),
    )
    // Notify all session subscribers
    await redis.publish(
      REDIS_KEYS.sessionChannel(input.connectionId),
      JSON.stringify({
        type: 'connection:terminated',
        connectionId: input.connectionId,
      }),
    )
    // Delete presence keys
    await redis.del(REDIS_KEYS.gatewayOnline(input.connectionId))
    await redis.del(REDIS_KEYS.connectionState(input.connectionId))

    logger.info({ connectionId: input.connectionId }, 'revocation:connection-revoked')
  }
}

export const revocationService = new RevocationService()
