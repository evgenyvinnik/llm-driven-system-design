/**
 * Change notifications. Published to one Valkey channel after a transaction
 * commits; every API instance subscribes and writes matching events to its own
 * SSE streams. Events are hints, never the source of truth: each carries the
 * revision it describes, and a client that sees a gap (or reconnects) refetches.
 * @module shared/events
 */
import type { EffectiveEntry } from '../domain/types.js'
import { keys, redis } from './cache.js'
import { config } from './config.js'
import { logger } from './logger.js'
import { eventsPublished } from './metrics.js'

/** A user's own settings changed. Carries the changed keys' new effective entries (a delta). */
export interface UserChangedEvent {
  type: 'user'
  userId: string
  orgId: string
  revision: number
  /** The org and catalog revisions the entries were resolved against. A client on a different one refetches. */
  orgRevision: number
  catalogRevision: number
  changes: Record<string, EffectiveEntry>
  clientId: string | null
  clientLabel: string | null
  origin: string
  at: string
}

/** An org's policy changed. Effective values differ per user, so this is an invalidation: members refetch. */
export interface OrgChangedEvent {
  type: 'org'
  orgId: string
  orgRevision: number
  keys: string[]
  origin: string
  at: string
}

/** The catalog changed (definition added or deprecated). Everyone refetches definitions and settings. */
export interface CatalogChangedEvent {
  type: 'catalog'
  catalogRevision: number
  keys: string[]
  origin: string
  at: string
}

export type ChangeEvent = UserChangedEvent | OrgChangedEvent | CatalogChangedEvent

type Unstamped<T> = T extends ChangeEvent ? Omit<T, 'origin' | 'at'> : never

/**
 * Best effort, after commit. If Valkey is down the write still succeeded:
 * other devices catch up on their next reconnect, focus or revision gap.
 */
export async function publishEvent(event: Unstamped<ChangeEvent>): Promise<void> {
  const stamped = { ...event, origin: config.instanceId, at: new Date().toISOString() } as ChangeEvent
  try {
    await redis.publish(keys.events, JSON.stringify(stamped))
    eventsPublished.inc({ type: event.type, result: 'ok' })
  } catch (err) {
    eventsPublished.inc({ type: event.type, result: 'error' })
    logger.warn({ err: (err as Error).message, type: event.type }, 'event publish failed; clients will resync')
  }
}
