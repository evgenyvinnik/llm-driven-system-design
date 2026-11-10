/**
 * Valkey/Redis client and key names. Valkey holds sessions and the login rate
 * limit only; it never holds a decision, so losing it signs people out and
 * changes nothing about any review.
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export const redis = new Redis(config.redisUrl, { connectionName: 'ai-code-review', maxRetriesPerRequest: 2, lazyConnect: false })
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'))

const p = config.keyPrefix

export const keys = {
  session: (id: string) => `${p}session:${id}`,
  rate: (bucket: string) => `${p}rate:${bucket}`,
}
