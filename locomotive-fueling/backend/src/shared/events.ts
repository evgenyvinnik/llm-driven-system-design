/**
 * Live update fan-out. Workers publish small "something changed" events on a
 * Valkey channel; each API instance relays them to browsers over SSE after an
 * access check. Events carry ids, not data: the browser refetches what it is
 * allowed to see, so a missed event costs freshness, never correctness.
 * @module shared/events
 */
import { keys, redis } from './cache.js'
import { logger } from './logger.js'

export type LiveEventType = 'train' | 'plan' | 'alert' | 'order' | 'price' | 'ticket'

export interface LiveEvent {
  type: LiveEventType
  trainId?: string | null
  id?: string | number
  note?: string
}

export async function publishEvent(event: LiveEvent): Promise<void> {
  try {
    await redis.publish(keys.events, JSON.stringify(event))
  } catch (err) {
    // Live updates are best effort; the UI also refetches on reconnect.
    logger.warn({ err: (err as Error).message }, 'publish failed')
  }
}
