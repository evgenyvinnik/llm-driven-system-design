/**
 * Valkey/Redis client and key names. Valkey holds sessions and the login rate
 * limit only; it is never a source of truth, so losing it signs people out
 * and loses nothing else.
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export const redis = new Redis(config.redisUrl, { connectionName: 'evals', maxRetriesPerRequest: 2, lazyConnect: false })
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'))

const p = config.keyPrefix

export const keys = {
  session: (id: string) => `${p}session:${id}`,
  rate: (bucket: string) => `${p}rate:${bucket}`,
}
