/**
 * Valkey/Redis client and key names. Valkey holds sessions, the login rate limit
 * and the log wake-up channel. None of it is a source of truth: losing Valkey
 * signs people out and slows live logs to polling, but loses no run and no log line.
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export function createRedisConnection(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: 2,
    // A paused Valkey must fail a command, not hang the request that sent it.
    commandTimeout: 3000,
    lazyConnect: false,
  })
  client.on('error', (err) => logger.warn({ err: err.message, code: (err as { code?: string }).code, name }, 'redis connection error'))
  return client
}

export const redis = createRedisConnection('shared')

const p = config.keyPrefix

/** Every key name in one place, so the data model is readable. */
export const keys = {
  session: (id: string) => `${p}session:${id}`,
  rate: (bucket: string) => `${p}rate:${bucket}`,
  logChannel: `${p}logs`,
}
