/**
 * Valkey Streams standing in for Kafka topics.
 *
 * Each topic has N partitions, one Valkey stream per partition
 * (`th:<topic>:<p>`). The partition is hash(partition key) mod N, so every
 * event for one track segment lands on one partition and is consumed in order.
 * Lanes are separate topics: `edge.critical` never queues behind `edge.bulk`.
 *
 * | Valkey                         | Kafka                               |
 * |--------------------------------|-------------------------------------|
 * | stream th:edge.critical:2      | topic edge.critical, partition 2    |
 * | consumer group "correlator"    | consumer group "correlator"         |
 * | XACK after commit              | commit offset after processing      |
 * | XAUTOCLAIM idle pending        | rebalance hands a dead member's     |
 * |                                | partitions to a live member         |
 * | th:dlq                         | dead-letter topic                   |
 * @module shared/streams
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'
import type { Topic } from './event-store.js'

export const TOPICS: Topic[] = ['edge.critical', 'domain', 'trains', 'edge.bulk']
export const DLQ_KEY = `${config.streams.prefix}:dlq`
export const DLQ_STATUS_KEY = `${config.streams.prefix}:dlq:status`

export const streamKey = (topic: Topic, partition: number) => `${config.streams.prefix}:${topic}:${partition}`

/** FNV-1a, like a stable Kafka partitioner: the same key always maps to the same partition. */
export function partitionFor(key: string, partitions = config.streams.partitions): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % partitions
}

export function partitionsOf(topic: Topic, owned = allPartitions()): string[] {
  return owned.map((p) => streamKey(topic, p))
}

export function allPartitions(): number[] {
  return Array.from({ length: config.streams.partitions }, (_, i) => i)
}

/** Parses "0,1" or "0-3" (static partition assignment per consumer instance). Defaults to all. */
export function parsePartitions(spec: string | undefined): number[] {
  if (!spec) return allPartitions()
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((n) => Number.parseInt(n, 10))
    if (Number.isFinite(a) && Number.isFinite(b)) for (let i = a; i <= b; i++) out.add(i)
    else if (Number.isFinite(a)) out.add(a)
  }
  return [...out].filter((p) => p >= 0 && p < config.streams.partitions).sort((x, y) => x - y)
}

export function topicOfKey(key: string): Topic | null {
  const m = key.match(/^[^:]+:([^:]+):(\d+)$/)
  return m ? (m[1] as Topic) : null
}

export async function ensureGroup(client: Redis, keys: string[], group: string): Promise<void> {
  for (const key of keys) {
    try {
      await client.xgroup('CREATE', key, group, '0', 'MKSTREAM')
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

export interface GroupInfo {
  key: string
  topic: Topic | null
  partition: number
  length: number
  group: string
  lag: number | null
  pending: number
  lastDeliveredId: string
  consumers: number
}

/** XINFO STREAM + XINFO GROUPS for every partition of the given topics. Valkey 7 reports per-group lag. */
export async function describeTopics(client: Redis, topics: Topic[]): Promise<GroupInfo[]> {
  const out: GroupInfo[] = []
  for (const topic of topics) {
    for (const p of allPartitions()) {
      const key = streamKey(topic, p)
      const length = (await client.xlen(key)) as number
      const groups = ((await client.xinfo('GROUPS', key).catch(() => [])) ?? []) as unknown[]
      for (const g of groups) {
        const o = fieldsToObject((g as unknown[]).map(String))
        out.push({
          key,
          topic,
          partition: p,
          length,
          group: o.name,
          lag: o.lag === undefined || o.lag === '' || o.lag === 'null' ? null : Number(o.lag),
          pending: Number(o.pending ?? 0),
          lastDeliveredId: o['last-delivered-id'] ?? '0-0',
          consumers: Number(o.consumers ?? 0),
        })
      }
    }
  }
  return out
}
