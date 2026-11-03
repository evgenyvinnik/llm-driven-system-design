/**
 * Valkey/Redis client: sessions, ingest dedup claims, partition positions,
 * per-org revision counters and the query result cache.
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

export { keys } from './keys.js'
