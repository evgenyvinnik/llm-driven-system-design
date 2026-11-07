/**
 * Valkey clients and key names. One shared client handles commands; the
 * pub/sub subscriber needs its own connection. Nothing in Valkey is a source
 * of truth except the event stream between ingest and the worker (AOF on).
 * @module shared/cache
 */
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export function createRedisConnection(name: string): Redis {
  const client = new Redis(config.redisUrl, { connectionName: name, maxRetriesPerRequest: null, lazyConnect: false })
  client.on('error', (err) => logger.warn({ err: err.message, name }, 'redis connection error'))
  return client
}

export const redis = createRedisConnection('shared')

const p = config.keyPrefix

/** Every key name in one place, so the data model is readable. */
export const keys = {
  session: (id: string) => `${p}session:${id}`,
  shopSession: (id: string) => `${p}shop-session:${id}`,
  rate: (bucket: string) => `${p}rate:${bucket}`,
  /** Latest compiled snapshot of an environment: {version, etag, body}. Written only forward (Lua CAS). */
  snapshotLatest: (env: string) => `${p}snapshot:${env}:latest`,
  /** When a snapshot version was published (ms), to measure propagation to SDK clients. */
  snapshotPublishedAt: (env: string, version: number) => `${p}snapshot:${env}:published:${version}`,
  /** The pub/sub channel carrying {environment, version} of every new snapshot. */
  snapshotChannel: `${p}snapshots`,
  /** Ingest → worker. One entry per accepted SDK batch. */
  eventStream: `${p}events`,
  eventGroup: 'ingest',
  /** A batch id seen within the dedup window. */
  batchSeen: (env: string, batchId: string) => `${p}batch:${env}:${batchId}`,
  /** Live SDK clients of an environment: hash sdkInstanceId → JSON of what the SDK last reported. */
  clients: (env: string) => `${p}clients:${env}`,
  /** SSE connection state per SDK instance (written only by the stream route, so it never races a report). */
  streams: (env: string) => `${p}streams:${env}`,
  /** Cache of identity aliases (userId → stableId). */
  alias: (env: string, userId: string) => `${p}alias:${env}:${userId}`,
  /** Ingest worker heartbeat, for the console. */
  workerHeartbeat: `${p}worker:heartbeat`,
}
