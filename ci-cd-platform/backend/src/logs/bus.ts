/**
 * Wakes log readers on any API instance when new lines exist. Only a nudge: the
 * lines themselves are always read from PostgreSQL by offset, so a lost message
 * costs at most the 2 s poll, never a line. One subscriber connection per process.
 * @module logs/bus
 */
import type { Redis } from 'ioredis'
import { createRedisConnection, keys, redis } from '../shared/cache.js'
import { logger } from '../shared/logger.js'

type Listener = () => void
const listeners = new Map<string, Set<Listener>>()
let subscriber: Redis | null = null

const topic = (jobId: string, attempt: number) => `${jobId}:${attempt}`

function ensureSubscriber(): void {
  if (subscriber) return
  subscriber = createRedisConnection('log-bus')
  void subscriber.subscribe(keys.logChannel).catch((err: Error) => logger.warn({ err: err.message }, 'log bus subscribe failed; readers fall back to polling'))
  subscriber.on('message', (_channel: string, message: string) => {
    for (const l of listeners.get(message) ?? []) l()
  })
}

export function subscribeLogs(jobId: string, attempt: number, listener: Listener): () => void {
  ensureSubscriber()
  const key = topic(jobId, attempt)
  const set = listeners.get(key) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

export async function publishLogs(jobId: string, attempt: number): Promise<void> {
  await redis.publish(keys.logChannel, topic(jobId, attempt)).catch((err: Error) => logger.warn({ err: err.message }, 'log bus publish failed; readers fall back to polling'))
}
