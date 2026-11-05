/**
 * Dispatch over a Valkey stream with a consumer group. The stream only says
 * "look at target N"; PostgreSQL decides whether there is anything to do. So
 * duplicate deliveries, redeliveries after a crash and reconciler re-sends
 * are all harmless, and losing the stream entirely loses nothing: the
 * coordinator's reconciler re-sends every due target from PostgreSQL.
 * @module executor/queue
 */
import type { Redis } from 'ioredis'
import type { CampaignEvent } from './types.js'

export interface TaskMessage {
  messageId: string
  targetId: number
}

type StreamEntries = [string, string[]][]

function parseEntries(entries: StreamEntries): TaskMessage[] {
  return entries.flatMap(([messageId, fields]) => {
    const i = fields.indexOf('target')
    const targetId = i >= 0 ? Number(fields[i + 1]) : NaN
    return Number.isFinite(targetId) ? [{ messageId, targetId }] : []
  })
}

export class TaskQueue {
  constructor(
    private redis: Redis,
    private stream: string,
    private group: string,
  ) {}

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM')
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err
    }
  }

  async enqueue(targetIds: number[]): Promise<void> {
    if (targetIds.length === 0) return
    const pipeline = this.redis.pipeline()
    for (const id of targetIds) pipeline.xadd(this.stream, 'MAXLEN', '~', '200000', '*', 'target', String(id))
    await pipeline.exec()
  }

  /** Blocking read on a dedicated connection. */
  async read(conn: Redis, consumer: string, blockMs: number): Promise<TaskMessage[]> {
    const res = (await conn.xreadgroup('GROUP', this.group, consumer, 'COUNT', 1, 'BLOCK', blockMs, 'STREAMS', this.stream, '>')) as [string, StreamEntries][] | null
    return res ? parseEntries(res[0][1]) : []
  }

  async ack(messageId: string): Promise<void> {
    await this.redis.xack(this.stream, this.group, messageId)
  }

  /** Takes over messages a crashed consumer read but never acknowledged. */
  async autoclaim(consumer: string, minIdleMs: number): Promise<TaskMessage[]> {
    const res = (await this.redis.xautoclaim(this.stream, this.group, consumer, minIdleMs, '0-0', 'COUNT', 100)) as [string, StreamEntries]
    return parseEntries(res[1] ?? [])
  }
}

/** Live progress for the UI (best effort; PostgreSQL remains the record). */
export async function publishEvent(redis: Redis, key: string, event: CampaignEvent): Promise<void> {
  try {
    await redis.xadd(key, 'MAXLEN', '~', '2000', '*', 'e', JSON.stringify({ ...event, at: new Date().toISOString() }))
  } catch {
    // Losing a progress event only delays the UI until its next snapshot.
  }
}
