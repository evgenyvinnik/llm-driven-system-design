/**
 * Valkey/Redis client and key names. Valkey holds sessions, the answer cache
 * (with a per-document reverse index so purge can find entries), per-run event
 * streams and the cancel channel. None of it is a source of truth: every
 * cached answer is validated against PostgreSQL before it is served, and
 * losing Valkey signs people out and empties the cache but loses no document.
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
  /** One cached answer: org + user + normalized question hash. */
  answer: (orgId: string, userId: string, questionHash: string) => `${p}ans:${orgId}:${userId}:${questionHash}`,
  /** Set of answer keys whose context used this document (purge reads it; never DEL by pattern). */
  answersByDoc: (documentId: string) => `${p}ansdoc:${documentId}`,
  /** Event log of one answer run (XADD), replayable from any API instance by entry id. */
  runEvents: (runId: string) => `${p}run:${runId}:events`,
  cancelChannel: `${p}cancel`,
}
