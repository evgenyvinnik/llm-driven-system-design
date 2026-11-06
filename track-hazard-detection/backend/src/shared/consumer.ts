/**
 * A consumer-group reader over partitioned Valkey streams, with:
 *
 * - **Priority lanes.** Lanes are read in order. After every batch the reader
 *   starts again from the top lane, so a critical message waits behind at most
 *   one bulk batch, never behind a whole reconnect backlog.
 * - **Ack after commit.** The handler commits its PostgreSQL transaction
 *   (including its processed-events row) before XACK. A crash in between means
 *   redelivery, which the handler's idempotency check turns into a no-op.
 * - **Retry in place, then dead-letter.** A transient failure is retried on the
 *   same message with backoff (keeping per-partition order). A permanent
 *   failure, or a transient one that outlives `maxDeliveries`, goes to the DLQ.
 * - **Recovery.** On start, the consumer re-processes its own pending entries
 *   (XREADGROUP ... 0). XAUTOCLAIM takes over entries left pending by a dead
 *   consumer instance.
 * @module shared/consumer
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'
import { createRedisConnection } from './cache.js'
import type { Topic } from './event-store.js'
import { parseEnvelope, PermanentError, type Envelope } from './events/envelope.js'
import { logger } from './logger.js'
import { consumerLag, consumerPending, consumerProcessed, consumerSeconds } from './metrics.js'
import { DLQ_KEY, ensureGroup, fieldsToObject, partitionsOf, streamKey, topicOfKey } from './streams.js'

export interface MessageContext {
  key: string
  topic: Topic
  id: string
  deliveries: number
}

export type HandlerOutcome = 'ok' | 'duplicate' | 'skipped'
export type Handler = (env: Envelope, ctx: MessageContext) => Promise<HandlerOutcome | void>

export interface ConsumerOptions {
  group: string
  consumer: string
  /** In priority order: the first lane is always drained first. */
  lanes: Array<{ topic: Topic; batch: number }>
  partitions: number[]
  handle: Handler
  blockMs?: number
  maxDeliveries?: number
  claimIdleMs?: number
  /** Backoff before each in-place retry (ms). */
  retryDelaysMs?: number[]
}

type StreamReply = Array<[string, Array<[string, string[] | null]>]> | null

export type Disposition = 'ack' | 'retry' | 'dead_letter'

/** What to do with a message whose handler threw. Pure, so the policy is unit-tested. */
export function dispositionFor(err: unknown, attempt: number, maxDeliveries: number): Disposition {
  if (err instanceof PermanentError) return 'dead_letter'
  return attempt >= maxDeliveries ? 'dead_letter' : 'retry'
}

export class StreamConsumer {
  private running = false
  private readonly reader: Redis
  private readonly cmd: Redis
  private timers: NodeJS.Timeout[] = []
  private loopDone: Promise<void> | null = null
  /** Entries taken over by XAUTOCLAIM, handled by the main loop so handling stays single-threaded. */
  private claimed: Array<{ key: string; id: string; fields: string[] | null; deliveries: number }> = []
  private readonly opts: Required<ConsumerOptions>

  constructor(opts: ConsumerOptions, deps?: { reader?: Redis; cmd?: Redis }) {
    this.opts = {
      blockMs: 500,
      maxDeliveries: config.streams.maxDeliveries,
      claimIdleMs: config.streams.claimIdleMs,
      retryDelaysMs: [100, 400, 1200],
      ...opts,
    }
    this.reader = deps?.reader ?? createRedisConnection(`${opts.group}-reader`)
    this.cmd = deps?.cmd ?? createRedisConnection(`${opts.group}-cmd`)
  }

  private keysFor(topic: Topic): string[] {
    return partitionsOf(topic, this.opts.partitions)
  }

  private get allKeys(): string[] {
    return this.opts.lanes.flatMap((l) => this.keysFor(l.topic))
  }

  async start(): Promise<void> {
    await ensureGroup(this.cmd, this.allKeys, this.opts.group)
    this.running = true
    await this.recoverOwnPending()
    this.loopDone = this.loop()
    this.timers.push(setInterval(() => void this.claimStale().catch((err) => logger.warn({ err: err.message }, 'autoclaim failed')), this.opts.claimIdleMs))
    this.timers.push(setInterval(() => void this.updateLag().catch(() => undefined), 5_000))
    logger.info({ group: this.opts.group, consumer: this.opts.consumer, partitions: this.opts.partitions, lanes: this.opts.lanes.map((l) => l.topic) }, 'consumer started')
  }

  async stop(): Promise<void> {
    this.running = false
    for (const t of this.timers) clearInterval(t)
    this.reader.disconnect()
    await this.loopDone?.catch(() => undefined)
    await this.cmd.quit().catch(() => undefined)
  }

  /** Entries this consumer name received but never acknowledged (it crashed mid-batch). */
  private async recoverOwnPending(): Promise<void> {
    for (const key of this.allKeys) {
      const reply = (await this.cmd.xreadgroup('GROUP', this.opts.group, this.opts.consumer, 'COUNT', 1000, 'STREAMS', key, '0')) as StreamReply
      const entries = reply?.[0]?.[1] ?? []
      if (entries.length) logger.warn({ key, count: entries.length }, 'reprocessing own pending entries after restart')
      for (const [id, fields] of entries) await this.handleEntry(key, id, fields, 2)
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        while (this.claimed.length) {
          const c = this.claimed.shift()!
          await this.handleEntry(c.key, c.id, c.fields, c.deliveries)
        }
        let handled = false
        for (const lane of this.opts.lanes) {
          const keys = this.keysFor(lane.topic)
          const reply = (await this.reader.xreadgroup('GROUP', this.opts.group, this.opts.consumer, 'COUNT', lane.batch, 'STREAMS', ...keys, ...keys.map(() => '>'))) as StreamReply
          if (reply && reply.some(([, entries]) => entries.length > 0)) {
            await this.handleReply(reply)
            handled = true
            break // back to the top lane
          }
        }
        if (!handled && this.running) {
          const keys = this.allKeys
          const reply = (await this.reader.xreadgroup('GROUP', this.opts.group, this.opts.consumer, 'COUNT', 10, 'BLOCK', this.opts.blockMs, 'STREAMS', ...keys, ...keys.map(() => '>'))) as StreamReply
          if (reply) await this.handleReply(reply)
        }
      } catch (err) {
        if (!this.running) break
        const message = (err as Error).message
        // The streams were wiped (npm run db:seed) under a running consumer: recreate the group and carry on.
        if (message.includes('NOGROUP')) await ensureGroup(this.cmd, this.allKeys, this.opts.group).catch(() => undefined)
        logger.error({ err: message, group: this.opts.group }, 'consumer loop error')
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  private async handleReply(reply: NonNullable<StreamReply>): Promise<void> {
    for (const [key, entries] of reply) {
      for (const [id, fields] of entries) await this.handleEntry(key, id, fields, 1)
    }
  }

  private async handleEntry(key: string, id: string, fields: string[] | null, deliveries: number): Promise<void> {
    const topic = (topicOfKey(key) ?? 'domain') as Topic
    if (!fields) {
      // The entry was trimmed away while pending; nothing to process.
      await this.cmd.xack(key, this.opts.group, id)
      return
    }
    const raw = fieldsToObject(fields)
    let attempt = deliveries
    while (true) {
      const end = consumerSeconds.startTimer({ group: this.opts.group, topic })
      try {
        const env = parseEnvelope(raw.event ?? '')
        const outcome = (await this.opts.handle(env, { key, topic, id, deliveries: attempt })) ?? 'ok'
        await this.cmd.xack(key, this.opts.group, id)
        consumerProcessed.inc({ group: this.opts.group, topic, outcome })
        end()
        return
      } catch (err) {
        end()
        const disposition = dispositionFor(err, attempt, this.opts.maxDeliveries)
        if (disposition === 'dead_letter') {
          await this.deadLetter(key, id, raw, err, attempt)
          return
        }
        consumerProcessed.inc({ group: this.opts.group, topic, outcome: 'retry' })
        logger.warn({ err: (err as Error).message, key, id, attempt, group: this.opts.group }, 'handler failed; retrying in place')
        const delay = this.opts.retryDelaysMs[Math.min(attempt - 1, this.opts.retryDelaysMs.length - 1)] ?? 500
        await new Promise((r) => setTimeout(r, delay))
        attempt += 1
        if (!this.running) return // leave it pending; the next start recovers it
      }
    }
  }

  private async deadLetter(key: string, id: string, raw: Record<string, string>, err: unknown, deliveries: number): Promise<void> {
    const code = (err as { code?: string }).code ?? (err instanceof PermanentError ? 'PERMANENT' : 'RETRIES_EXHAUSTED')
    await this.cmd.xadd(
      DLQ_KEY,
      '*',
      'key', key,
      'topic', topicOfKey(key) ?? '',
      'group', this.opts.group,
      'consumer', this.opts.consumer,
      'messageId', id,
      'eventId', raw.eventId ?? '',
      'type', raw.type ?? '',
      'code', String(code),
      'permanent', err instanceof PermanentError ? '1' : '0',
      'error', (err as Error).message ?? String(err),
      'deliveries', String(deliveries),
      'failedAt', new Date().toISOString(),
      'event', raw.event ?? '',
    )
    await this.cmd.xack(key, this.opts.group, id)
    consumerProcessed.inc({ group: this.opts.group, topic: topicOfKey(key) ?? 'unknown', outcome: 'dead_lettered' })
    logger.error({ key, id, code, group: this.opts.group, error: (err as Error).message }, 'message dead-lettered')
  }

  /** Takes over entries another (dead) consumer left pending for longer than claimIdleMs. */
  private async claimStale(): Promise<void> {
    if (!this.running) return
    for (const key of this.allKeys) {
      const reply = (await this.cmd.xautoclaim(key, this.opts.group, this.opts.consumer, this.opts.claimIdleMs, '0-0', 'COUNT', 100)) as [string, Array<[string, string[] | null]>]
      const entries = reply?.[1] ?? []
      for (const [id, fields] of entries) {
        const pending = (await this.cmd.xpending(key, this.opts.group, id, id, 1)) as Array<[string, string, number, number]>
        const deliveries = Number(pending?.[0]?.[3] ?? 2)
        logger.warn({ key, id, deliveries }, 'claimed a stale pending entry')
        if (!this.claimed.some((c) => c.key === key && c.id === id)) this.claimed.push({ key, id, fields, deliveries })
      }
    }
  }

  private async updateLag(): Promise<void> {
    for (const lane of this.opts.lanes) {
      let lag = 0
      let pending = 0
      for (const p of this.opts.partitions) {
        const key = streamKey(lane.topic, p)
        const groups = (await this.cmd.xinfo('GROUPS', key)) as unknown[]
        for (const g of groups) {
          const o = fieldsToObject((g as unknown[]).map(String))
          if (o.name !== this.opts.group) continue
          lag += Number(o.lag) || 0
          pending += Number(o.pending) || 0
        }
      }
      consumerLag.set({ group: this.opts.group, topic: lane.topic }, lag)
      consumerPending.set({ group: this.opts.group, topic: lane.topic }, pending)
    }
  }
}
