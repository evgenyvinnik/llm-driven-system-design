/**
 * Cross-process change notifications for the sync service (Redis pub/sub)
 *
 * Writes happen in the highlight service or the sync service; the reader's devices may be
 * connected to any sync instance. After a commit the writer publishes "user U's feed is now
 * at seq N" on the user's channel, and whichever sync instance holds U's sockets pokes them.
 * The message is only a hint: a lost poke delays a device until its next pull, it never
 * loses data, because the change feed in PostgreSQL is the source of truth.
 *
 * @module shared/notify
 */
import type { Request } from 'express'
import type { Logger } from 'pino'
import { redis } from './cache.js'

/** Payload published on a user's channel. */
export interface FeedAdvanced {
  seq: number
  /** The device that made the change; it already has it, so it is not poked. */
  device: string
}

/** Redis channel carrying one user's feed notifications. */
export function syncChannel(userId: string): string {
  return `sync:user:${userId}`
}

/** Publishes that the user's feed advanced. Best effort: failures are logged, never thrown. */
export async function notifyDevices(userId: string, seq: number, device: string, logger: Logger): Promise<void> {
  const message: FeedAdvanced = { seq, device }
  try {
    await redis.publish(syncChannel(userId), JSON.stringify(message))
  } catch (error) {
    logger.warn({ event: 'sync_notify_failed', userId, seq, error: (error as Error).message })
  }
}

/** The calling device, from the X-Device-Id header; requests without one count as 'api'. */
export function deviceIdFrom(req: Request): string {
  const header = req.headers['x-device-id']
  return typeof header === 'string' && /^[\w.:-]{1,100}$/.test(header) ? header : 'api'
}
