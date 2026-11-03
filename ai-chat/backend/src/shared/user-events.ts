/**
 * Per-user change notifications, fanned out to every device the user has open.
 *
 * Publishing is fire-and-forget Valkey pub/sub: a device that is offline or
 * reconnecting misses events, so these are hints, never the record. Each
 * device re-reads the conversation list and its active generations from the
 * REST API whenever its event stream (re)connects, and PostgreSQL stays the
 * source of truth.
 * @module shared/user-events
 */
import type { Redis } from 'ioredis'
import { logger } from './logger.js'

export const userEventsChannel = (userId: string) => `user:${userId}:events`

export type UserEvent =
  | { type: 'generation.created'; conversationId: string; generationId: string; payload: unknown }
  | {
      type: 'generation.finished'
      conversationId: string
      generationId: string
      assistantMessageId: string
      status: string
    }
  | { type: 'conversation.updated'; conversationId: string; payload: unknown }
  | { type: 'conversation.deleted'; conversationId: string }
  | { type: 'leaf.changed'; conversationId: string; leafId: string }

export async function publishUserEvent(redis: Redis, userId: string, event: UserEvent): Promise<void> {
  try {
    await redis.publish(userEventsChannel(userId), JSON.stringify(event))
  } catch (err) {
    // Losing a hint is fine: devices reconcile from REST on reconnect.
    logger.warn({ err, userId, type: event.type }, 'could not publish user event')
  }
}
