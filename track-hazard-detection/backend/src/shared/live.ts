/**
 * Live-update notices. Services publish a small notice to a Valkey channel after
 * a transaction commits; each API instance relays notices over SSE. Notices
 * carry ids, not state: the browser refetches through the access-checked read
 * APIs. Publishing is best-effort; a lost notice only delays a screen refresh.
 * @module shared/live
 */
import { redis } from './cache.js'
import { config } from './config.js'
import { logger } from './logger.js'

export type LiveTopic = 'hazards' | 'alerts' | 'restrictions' | 'trains' | 'coverage' | 'ops' | 'latency'

export interface LiveNotice {
  topics: LiveTopic[]
  hazardId?: string
  severity?: string
  type?: string
}

export async function publishLive(notices: LiveNotice[]): Promise<void> {
  if (notices.length === 0) return
  try {
    const pipeline = redis.pipeline()
    for (const n of notices) pipeline.publish(config.liveChannel, JSON.stringify(n))
    await pipeline.exec()
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'live notice publish failed')
  }
}
