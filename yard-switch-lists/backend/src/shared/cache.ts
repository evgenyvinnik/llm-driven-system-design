/**
 * Valkey/Redis clients and key names. One shared client handles commands;
 * blocking reads (XREADGROUP BLOCK) need their own connection.
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export function createRedisConnection(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: null,
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
  holdStream: `${p}${config.holds.stream}`,
  pattern: `${p}*`,
}
