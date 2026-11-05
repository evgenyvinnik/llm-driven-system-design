/**
 * Valkey/Redis clients and key names. One shared client handles commands;
 * blocking reads (XREADGROUP BLOCK) and pub/sub each need their own connection.
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
  batchSeen: (batchId: string) => `${p}ingest:batch:${batchId}`,
  telemetryStream: (partition: number) => `${p}telemetry:p${partition}`,
  locoState: (locoId: string) => `${p}loco:${locoId}:state`,
  locoFilter: (locoId: string) => `${p}loco:${locoId}:filter`,
  trainState: (trainId: string) => `${p}train:${trainId}:state`,
  /** Train-level calibration factor the current plan was computed with (the deviation band is measured from it). */
  trainPlanCal: (trainId: string) => `${p}train:${trainId}:plancal`,
  /** Train-level burn calibration as the processor measures it (Σ actual / Σ forecast over healthy units). */
  trainCal: (trainId: string) => `${p}train:${trainId}:cal`,
  planRequests: `${p}plan:requests`,
  planPending: (trainId: string) => `${p}plan:pending:${trainId}`,
  planLock: (trainId: string) => `${p}plan:lock:${trainId}`,
  simClock: `${p}sim:clock`,
  events: `${p}events`,
  rate: (bucket: string) => `${p}rate:${bucket}`,
  pattern: `${p}*`,
}
