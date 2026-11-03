/**
 * lib/services/v2/event.service.ts
 * Writes structured events to connection_events and publishes to Redis.
 */
import 'server-only'
import { db } from '../../db'
import { redis, REDIS_KEYS } from '../../redis'
import { logger } from '../../logger'

export type ConnectionEventType =
  | 'GATEWAY_REGISTERED'
  | 'GATEWAY_HEARTBEAT'
  | 'GATEWAY_VERIFIED'
  | 'GATEWAY_FAILED'
  | 'GATEWAY_DISCONNECTED'
  | 'CONNECTION_READY'
  | 'CONNECTION_ACTIVATED'
  | 'CONNECTION_PAUSED'
  | 'CONNECTION_TERMINATED'
  | 'CONNECTION_EXPIRED'
  | 'JOIN_REQUESTED'
  | 'PARTICIPANT_APPROVED'
  | 'PARTICIPANT_REJECTED'
  | 'PARTICIPANT_REVOKED'
  | 'PARTICIPANT_LEFT'
  | 'TUNNEL_PROVISIONED'
  | 'TUNNEL_ESTABLISHED'
  | 'TUNNEL_RECONNECTING'
  | 'TUNNEL_TERMINATED'
  | 'USAGE_UPDATED'
  | 'ROUTING_ACTIVATED'
  | 'ROUTING_DEACTIVATED'

export class EventService {
  async emit(
    connectionId: string,
    eventType: ConnectionEventType,
    metadata?: unknown,
  ): Promise<void> {
    // Persist to DB
    try {
      await db.connectionEvent.create({
        data: { connectionId, eventType, eventMetadata: metadata as never },
      })
    } catch (err) {
      logger.warn({ err, connectionId, eventType }, 'event:db-write-failed')
    }

    // Publish to session-wide Redis channel
    try {
      await redis.publish(
        REDIS_KEYS.sessionChannel(connectionId),
        JSON.stringify({ type: eventType, connectionId, metadata, ts: Date.now() }),
      )
    } catch (err) {
      logger.warn({ err, eventType }, 'event:publish-failed')
    }
  }

  async emitToCreator(
    connectionId: string,
    eventType: ConnectionEventType,
    metadata?: unknown,
  ): Promise<void> {
    try {
      await redis.publish(
        REDIS_KEYS.creatorChannel(connectionId),
        JSON.stringify({ type: eventType, connectionId, metadata, ts: Date.now() }),
      )
    } catch (err) {
      logger.warn({ err, eventType }, 'event:creator-publish-failed')
    }
  }

  async emitToParticipant(
    participantId: string,
    eventType: ConnectionEventType,
    metadata?: unknown,
  ): Promise<void> {
    try {
      await redis.publish(
        REDIS_KEYS.participantChannel(participantId),
        JSON.stringify({ type: eventType, participantId, metadata, ts: Date.now() }),
      )
    } catch (err) {
      logger.warn({ err, eventType }, 'event:participant-publish-failed')
    }
  }
}

export const eventService = new EventService()
