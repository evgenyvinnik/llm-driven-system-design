/**
 * The dead-letter stream. A message lands here when its consumer group gave up
 * on it: a permanent error (a payload that fails its schema, a schema version
 * this consumer doesn't know) at once, or a transient error after
 * STREAM_MAX_DELIVERIES attempts. Its consumer group acked the original so the
 * group keeps moving; the entry keeps the error, the attempt count and the raw
 * event. Redrive puts the event back on its original stream addressed to that
 * one group (other groups see redriveFor and skip it), after the cause is fixed.
 * @module events/dlq
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { fieldsToObject } from '../shared/stream.js'

export interface DeadLetter {
  group: string
  streamKey: string
  messageId: string
  eventId: string
  type: string
  error: string
  permanent: boolean
  attempts: number
  deadAt: string
  /** The event exactly as it was on the broker (stored schema version). */
  event: string
}

export interface DeadLetterEntry extends DeadLetter {
  id: string
}

export async function deadLetter(redis: Redis, d: DeadLetter): Promise<string | null> {
  return redis.xadd(
    config.stream.deadLetterKey, 'MAXLEN', '~', '10000', '*',
    'group', d.group, 'streamKey', d.streamKey, 'messageId', d.messageId, 'eventId', d.eventId, 'type', d.type,
    'error', d.error.slice(0, 2000), 'permanent', d.permanent ? '1' : '0', 'attempts', String(d.attempts), 'deadAt', d.deadAt, 'event', d.event,
  )
}

const parse = ([id, fields]: [string, string[]]): DeadLetterEntry => {
  const f = fieldsToObject(fields)
  return {
    id, group: f.group, streamKey: f.streamKey, messageId: f.messageId, eventId: f.eventId, type: f.type, error: f.error,
    permanent: f.permanent === '1', attempts: Number(f.attempts), deadAt: f.deadAt, event: f.event,
  }
}

export async function listDeadLetters(redis: Redis, count = 100): Promise<DeadLetterEntry[]> {
  const rows = (await redis.xrevrange(config.stream.deadLetterKey, '+', '-', 'COUNT', count)) as Array<[string, string[]]>
  return rows.map(parse)
}

export async function dlqDepth(redis: Redis): Promise<number> {
  return redis.xlen(config.stream.deadLetterKey)
}

/** Re-publishes one dead letter to its original stream for its group only, then removes it. */
export async function redrive(redis: Redis, id: string): Promise<{ newMessageId: string; entry: DeadLetterEntry } | null> {
  const rows = (await redis.xrange(config.stream.deadLetterKey, id, id)) as Array<[string, string[]]>
  if (!rows[0]) return null
  const entry = parse(rows[0])
  let pos = '0'
  let key = ''
  try {
    const row = JSON.parse(entry.event) as { global_position?: number; partition_key?: string }
    pos = String(row.global_position ?? 0)
    key = row.partition_key ?? ''
  } catch {
    // a malformed event is redriven as is; it will dead-letter again
  }
  const newMessageId = await redis.xadd(
    entry.streamKey, '*', 'event', entry.event, 'type', entry.type, 'key', key, 'pos', pos, 'redriveFor', entry.group, 'redrivenFrom', id,
  )
  await redis.xdel(config.stream.deadLetterKey, id)
  return { newMessageId: newMessageId ?? '', entry }
}
