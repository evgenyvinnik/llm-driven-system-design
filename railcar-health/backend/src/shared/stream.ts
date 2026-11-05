/**
 * The pass stream: a Valkey stream standing in for a Kafka topic. Messages are
 * pointers ({ detectorId, passId }); the analyzer reads the pass from
 * PostgreSQL. Production would carry the payload and partition by trip.
 * @module shared/stream
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'

export async function publishPass(client: Redis, detectorId: string, passId: string): Promise<string | null> {
  return client.xadd(config.stream.key, 'MAXLEN', '~', '200000', '*', 'detectorId', detectorId, 'passId', passId)
}

/** Creates the consumer group from the start of the stream, so nothing published before the analyzer started is skipped. */
export async function ensureGroup(client: Redis): Promise<void> {
  try {
    await client.xgroup('CREATE', config.stream.key, config.stream.group, '0', 'MKSTREAM')
  } catch (err) {
    if (!(err as Error).message.includes('BUSYGROUP')) throw err
  }
}

export function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1]
  return out
}
