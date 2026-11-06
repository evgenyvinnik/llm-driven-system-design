/**
 * Valkey/Redis clients. One shared client handles commands; each blocking stream reader gets its own
 * connection from `createRedisConnection`, because XREADGROUP BLOCK holds the connection. Connections are
 * lazy: nothing connects until the first command (so importing a module in a unit test opens no socket).
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export function createRedisConnection(name: string): Redis {
  const client = new Redis(config.redisUrl, { connectionName: name, maxRetriesPerRequest: null, lazyConnect: true })
  client.on('error', (err) => logger.warn({ err: err.message, name }, 'redis connection error'))
  return client
}

export const redis = createRedisConnection('shared')
