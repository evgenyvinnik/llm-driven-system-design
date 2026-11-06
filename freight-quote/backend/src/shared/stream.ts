/**
 * Valkey Streams standing in for Kafka topics.
 *
 *  - `fq:events:p0..pN`: the outbox relay's output, partitioned by
 *    hash(stream_id), so all events of one quote land on one partition in
 *    append order (Kafka: topic quote.events keyed by quote id).
 *  - `fq:ext:pricing`: tariff and fuel-surcharge events from the pricing system.
 *  - `fq:redrive:<group>`: per-group redrive stream (Kafka: a per-group retry topic).
 *  - `fq:dlq`: dead letters, with the source stream, group, reason and attempts.
 *
 * Messages carry the full event envelope as JSON in the `event` field.
 * @module shared/stream
 */
import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { config } from './config.js'

export function partitionOf(streamId: string, partitions = config.streams.partitions): number {
  const digest = createHash('sha1').update(streamId).digest()
  return digest.readUInt32BE(0) % partitions
}

export const partitionKey = (p: number) => `${config.streams.partitionPrefix}${p}`
export const allPartitionKeys = () => Array.from({ length: config.streams.partitions }, (_, i) => partitionKey(i))
export const redriveKey = (group: string) => `${config.streams.redrivePrefix}${group}`

/** Consumer groups and the streams each one reads (its own redrive stream included). */
export const GROUPS = {
  completer: () => [...allPartitionKeys(), redriveKey('completer')],
  webhooks: () => [...allPartitionKeys(), redriveKey('webhooks')],
  projector: () => [...allPartitionKeys(), redriveKey('projector')],
  invalidator: () => [config.streams.external, redriveKey('invalidator')],
} as const
export type GroupName = keyof typeof GROUPS

export function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1]
  return out
}

export async function ensureGroup(client: Redis, stream: string, group: string): Promise<void> {
  try {
    await client.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
  } catch (err) {
    if (!(err as Error).message.includes('BUSYGROUP')) throw err
  }
}

export async function xaddEvent(client: Redis, stream: string, fields: Record<string, string>): Promise<string | null> {
  const flat = Object.entries(fields).flat()
  return client.xadd(stream, 'MAXLEN', '~', String(config.streams.maxLen), '*', ...flat)
}

export interface GroupInfo {
  stream: string
  group: string
  consumers: number
  pending: number
  lag: number | null
  lastDeliveredId: string
}

/** XINFO GROUPS per stream; `lag` is entries not yet delivered to the group (Valkey/Redis 7+). */
export async function groupInfo(client: Redis, stream: string): Promise<GroupInfo[]> {
  let raw: unknown[]
  try {
    raw = (await client.xinfo('GROUPS', stream)) as unknown[]
  } catch {
    return []
  }
  return raw.map((entry) => {
    const o = fieldsToObject((entry as unknown[]).map((v) => (v === null ? '' : String(v))))
    return {
      stream,
      group: o.name,
      consumers: Number(o.consumers ?? 0),
      pending: Number(o.pending ?? 0),
      lag: o.lag === undefined || o.lag === '' ? null : Number(o.lag),
      lastDeliveredId: o['last-delivered-id'] ?? '0-0',
    }
  })
}

export interface DeadLetter {
  id: string
  sourceStream: string
  sourceId: string
  group: string
  reason: string
  error: string
  deliveries: number
  deadAt: string
  event: string
  eventType: string | null
  eventId: string | null
}

export function toDeadLetter(id: string, fields: string[]): DeadLetter {
  const o = fieldsToObject(fields)
  let eventType: string | null = null
  let eventId: string | null = null
  try {
    const parsed = JSON.parse(o.event ?? '{}') as { type?: string; event_id?: string }
    eventType = parsed.type ?? null
    eventId = parsed.event_id ?? null
  } catch {
    // poison payloads may not be JSON at all
  }
  return {
    id,
    sourceStream: o.source_stream,
    sourceId: o.source_id,
    group: o.group,
    reason: o.reason,
    error: o.error,
    deliveries: Number(o.deliveries ?? 0),
    deadAt: o.dead_at,
    event: o.event ?? '',
    eventType,
    eventId,
  }
}

export async function listDeadLetters(client: Redis, count = 100): Promise<DeadLetter[]> {
  const rows = (await client.xrevrange(config.streams.deadLetter, '+', '-', 'COUNT', count)) as [string, string[]][]
  return rows.map(([id, fields]) => toDeadLetter(id, fields))
}

/** Moves a dead letter to its group's redrive stream. Only that group sees it again. */
export async function redriveDeadLetter(client: Redis, id: string): Promise<DeadLetter | null> {
  const rows = (await client.xrange(config.streams.deadLetter, id, id)) as [string, string[]][]
  if (rows.length === 0) return null
  const letter = toDeadLetter(rows[0][0], rows[0][1])
  await xaddEvent(client, redriveKey(letter.group), { event: letter.event, redriven_from: id, original_stream: letter.sourceStream })
  await client.xdel(config.streams.deadLetter, id)
  return letter
}

export async function discardDeadLetter(client: Redis, id: string): Promise<boolean> {
  return (await client.xdel(config.streams.deadLetter, id)) > 0
}
