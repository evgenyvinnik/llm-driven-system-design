/**
 * Valkey/Redis client and key names. Valkey holds sessions, login rate-limit
 * counters and the per-endpoint concurrency semaphores. None of it is a source
 * of truth: losing Valkey signs people out and briefly loosens concurrency
 * limits, but loses no event or delivery.
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export function createRedisConnection(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  })
  client.on('error', (err) => logger.warn({ err: err.message, name }, 'redis connection error'))
  return client
}

export const redis = createRedisConnection('shared')

const p = config.keyPrefix

/** Every key name in one place, so the data model is readable. */
export const keys = {
  session: (id: string) => `${p}session:${id}`,
  rate: (bucket: string) => `${p}rate:${bucket}`,
  /** Sorted set of in-flight lease tokens for one endpoint, scored by lease expiry (ms). */
  endpointSlots: (endpointId: string) => `${p}slots:${endpointId}`,
  slotsPattern: `${p}slots:*`,
}
