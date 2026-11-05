/**
 * The pass streams: two Valkey streams (live and backfill lanes) standing in for Kafka topics. Messages are
 * pointers ({ detectorId, passId }); the analyzer reads the pass from
 * PostgreSQL. Production would carry the payload and partition by trip.
 * @module shared/stream
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'

export type Lane = 'live' | 'backfill'

export const laneKey = (lane: Lane) => (lane === 'live' ? config.stream.liveKey : config.stream.backfillKey)

/**
 * Fresh passes go to the live lane; passes that sat in a gateway buffer go to
 * the backfill lane, so a reconnecting site's hours of backlog never queue in
 * front of a new critical reading from another site.
 */
export function laneFor(lagSeconds: number, lateAfterMinutes = config.analysis.lateAfterMinutes): Lane {
  return lagSeconds > lateAfterMinutes * 60 ? 'backfill' : 'live'
}

export async function publishPass(client: Redis, lane: Lane, detectorId: string, passId: string): Promise<string | null> {
  return client.xadd(laneKey(lane), 'MAXLEN', '~', '200000', '*', 'detectorId', detectorId, 'passId', passId)
}

/** Creates the consumer groups from the start of each stream, so nothing published before the analyzer started is skipped. */
export async function ensureGroup(client: Redis): Promise<void> {
  for (const key of [config.stream.liveKey, config.stream.backfillKey]) {
    try {
      await client.xgroup('CREATE', key, config.stream.group, '0', 'MKSTREAM')
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err
    }
  }
}

export function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1]
  return out
}
