/**
 * Live-update events. The analyzer and the API publish a small notice to a
 * Valkey channel after a transaction commits; each API instance relays notices
 * over SSE to the browsers allowed to see them. Notices carry IDs, not state:
 * the browser refetches through the normal, access-checked read APIs.
 * Publishing is best-effort; a lost notice only delays a screen refresh.
 * @module shared/events
 */
import { redis } from './cache.js'
import { config } from './config.js'
import { logger } from './logger.js'

export type LiveEventType =
  | 'alert.opened'
  | 'alert.escalated'
  | 'alert.updated'
  | 'workorder.updated'
  | 'trip.updated'
  | 'detector.updated'
  | 'pass.ingested'

export interface LiveEvent {
  type: LiveEventType
  alertId?: string
  tripId?: string
  carId?: string
  tier?: number
  deskId?: string | null
  yardId?: string | null
  late?: boolean
}

export async function publishEvents(events: LiveEvent[]): Promise<void> {
  if (events.length === 0) return
  try {
    const pipeline = redis.pipeline()
    for (const event of events) pipeline.publish(config.eventsChannel, JSON.stringify(event))
    await pipeline.exec()
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'live event publish failed')
  }
}
