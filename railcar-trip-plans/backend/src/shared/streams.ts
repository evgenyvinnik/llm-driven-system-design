/**
 * Valkey Streams standing in for Kafka topics. Each topic is split into N partition streams
 * (`tp:car:0..3`, `tp:train:0..1`, `tp:shipper:0`); an event goes to the partition its key hashes to, so
 * every event about one car lands in one stream, in order. A consumer group reads every partition stream of
 * the topics it subscribes to, plus its own retry stream; its dead letters go to its own DLQ stream.
 *
 *   Kafka                         here
 *   topic `car-events`, 4 parts   tp:car:0 … tp:car:3
 *   consumer group                XGROUP on each partition stream (same name)
 *   partition assignment          a lease per (group, partition) in Valkey
 *   committed offset              XACK after the database transaction commits
 *   retry topic per group         tp:retry:<group>
 *   DLQ topic per group           tp:dlq:<group>
 * @module shared/streams
 */
import type { Redis } from 'ioredis'
import { config, type Topic } from './config.js'

export const TOPICS: Topic[] = ['car', 'train', 'shipper']

/** FNV-1a: stable across processes and languages, unlike a runtime hash. */
export function partitionFor(key: string, partitions: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % partitions
}

export const streamKey = (topic: Topic, partition: number) => `${config.streams.prefix}:${topic}:${partition}`
export const retryKey = (group: string) => `${config.streams.prefix}:retry:${group}`
export const dlqKey = (group: string) => `${config.streams.prefix}:dlq:${group}`
export const leaseKey = (group: string, stream: string) => `${config.streams.prefix}:lease:${group}:${stream}`
export const errorsKey = (group: string) => `${config.streams.prefix}:errors:${group}`

export function partitionStreams(topic: Topic): string[] {
  return Array.from({ length: config.streams.partitions[topic] }, (_, p) => streamKey(topic, p))
}

export function streamFor(topic: Topic, key: string): string {
  return streamKey(topic, partitionFor(key, config.streams.partitions[topic]))
}

/** Creates the group at the start of the stream, so nothing published before the consumer first ran is skipped. */
export async function ensureGroup(client: Redis, stream: string, group: string): Promise<void> {
  try {
    await client.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
  } catch (err) {
    if (!(err as Error).message.includes('BUSYGROUP')) throw err
  }
}

export function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1]
  return out
}

/** Milliseconds encoded in a stream entry id ("1730851200000-0"). */
export function idTime(id: string | null | undefined): number | null {
  if (!id) return null
  const ms = Number.parseInt(id.split('-')[0], 10)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** Acquire-or-renew: succeeds when the lease is free or already ours. */
export const LEASE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0`

/** Releases a lease only if we still hold it. */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

/** The consumer groups and what they read. The API uses this to report lag; runners use it to subscribe. */
export const GROUPS: Record<string, Topic[]> = {
  'car-state': ['car', 'train'],
  eta: ['car', 'train'],
  exceptions: ['car'],
  notifier: ['car'],
  replanner: ['car', 'train'],
}
