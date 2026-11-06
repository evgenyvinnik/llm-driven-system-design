/**
 * A consumer-group worker over Valkey Streams with at-least-once delivery:
 *
 *  1. XREADGROUP new messages from every stream the group reads.
 *  2. The handler commits its own database transaction (with its idempotency
 *     record) and only then is the message XACKed. A crash between the two
 *     redelivers the message, and the handler's idempotency makes that a no-op.
 *  3. A failure leaves the message pending. A reclaim loop reads XPENDING and
 *     XCLAIMs a message once it has been idle for base * 2^(deliveries-1) ms
 *     (exponential backoff, also how a dead consumer's messages are taken over).
 *  4. A permanent failure (bad schema) or the Nth delivery goes to the
 *     dead-letter stream with the reason, and is acked.
 *
 * While a handler runs, a heartbeat re-claims its own message with JUSTID,
 * which resets idle time without counting a delivery, so a slow handler is
 * not mistaken for a dead one.
 * @module shared/consumer
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'
import { createRedisConnection } from './cache.js'
import { logger } from './logger.js'
import { ensureGroup, xaddEvent } from './stream.js'
import { consumerMessages, deadLettered } from './metrics.js'

export interface StreamMessage {
  stream: string
  id: string
  fields: Record<string, string>
  deliveries: number
}

export type Decision = 'retry' | 'dead_letter'

/** Permanent errors (schema, validation, missing aggregate) never succeed on retry. */
export function isPermanent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { permanent?: boolean }).permanent === true
}

export function decide(err: unknown, deliveries: number, maxDeliveries = config.streams.maxDeliveries): Decision {
  if (isPermanent(err)) return 'dead_letter'
  return deliveries >= maxDeliveries ? 'dead_letter' : 'retry'
}

export function backoffMs(deliveries: number, baseMs = config.streams.claimBaseMs): number {
  return baseMs * 2 ** Math.max(0, deliveries - 1)
}

export class PermanentError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = 'PermanentError'
  }
}

export interface ConsumerOptions {
  group: string
  consumer: string
  streams: string[]
  handle: (message: StreamMessage) => Promise<void>
  /**
   * Event types this group handles. Messages carry the type as a stream field (like a Kafka
   * header), so other types are acked without parsing, and a poison message of a type the group
   * never handles doesn't land in its DLQ.
   */
  types?: string[]
  /**
   * Messages handled at once. Only for groups whose handlers are order-insensitive (the completer):
   * one slow dependency call must not hold up every other quote's completion.
   */
  concurrency?: number
  /** Called after commit and before XACK; used to inject the "crash before ack" fault. */
  beforeAck?: (message: StreamMessage) => void
  batch?: number
}

export class StreamConsumer {
  private readonly reader: Redis
  private readonly client: Redis
  private running = false
  private readonly inFlight = new Set<string>()

  constructor(private readonly options: ConsumerOptions) {
    this.reader = createRedisConnection(`${options.group}-reader`)
    this.client = createRedisConnection(`${options.group}-client`)
  }

  async start(): Promise<void> {
    for (const stream of this.options.streams) await ensureGroup(this.client, stream, this.options.group)
    this.running = true
    void this.readLoop()
    void this.reclaimLoop()
    logger.info({ group: this.options.group, consumer: this.options.consumer, streams: this.options.streams }, 'consumer started')
  }

  async stop(): Promise<void> {
    this.running = false
    this.reader.disconnect()
    this.client.disconnect()
  }

  private async readLoop(): Promise<void> {
    const { group, consumer, streams } = this.options
    while (this.running) {
      try {
        const res = (await this.reader.xreadgroup(
          'GROUP', group, consumer,
          'COUNT', String(this.options.batch ?? 20),
          'BLOCK', String(config.streams.blockMs),
          'STREAMS', ...streams, ...streams.map(() => '>'),
        )) as [string, [string, string[]][]][] | null
        if (!res) continue
        const messages = res.flatMap(([stream, entries]) => entries.map(([id, raw]) => ({ stream, id, fields: toObject(raw), deliveries: 1 })))
        const width = Math.max(1, this.options.concurrency ?? 1)
        for (let i = 0; i < messages.length; i += width) {
          await Promise.all(messages.slice(i, i + width).map((m) => this.process(m)))
        }
      } catch (err) {
        if (!this.running) return
        const msg = (err as Error).message
        if (msg.includes('NOGROUP')) {
          // The stream was deleted (a reseed): recreate the groups and carry on.
          for (const stream of streams) await ensureGroup(this.client, stream, group).catch(() => undefined)
        } else {
          logger.warn({ err: msg, group }, 'read loop error')
        }
        await sleep(500)
      }
    }
  }

  /** Redelivers failed or abandoned messages with exponential backoff; dead-letters after maxDeliveries. */
  private async reclaimLoop(): Promise<void> {
    const { group, consumer, streams } = this.options
    while (this.running) {
      await sleep(Math.min(500, config.streams.claimBaseMs))
      for (const stream of streams) {
        try {
          const pending = (await this.client.xpending(stream, group, '-', '+', 100)) as [string, string, number, number][]
          for (const [id, , idle, deliveries] of pending) {
            if (this.inFlight.has(id)) continue
            if (deliveries >= config.streams.maxDeliveries && idle >= backoffMs(deliveries)) {
              const rows = (await this.client.xrange(stream, id, id)) as [string, string[]][]
              const fields = rows[0] ? toObject(rows[0][1]) : {}
              await this.deadLetter({ stream, id, fields, deliveries }, 'max_deliveries', 'retries exhausted')
              continue
            }
            if (idle < backoffMs(deliveries)) continue
            const claimed = (await this.client.xclaim(stream, group, consumer, backoffMs(deliveries), id)) as [string, string[]][]
            for (const [cid, raw] of claimed) {
              if (!raw) {
                // Trimmed out of the stream: nothing left to process.
                await this.client.xack(stream, group, cid)
                continue
              }
              consumerMessages.inc({ group, outcome: 'redelivered' })
              await this.process({ stream, id: cid, fields: toObject(raw), deliveries: deliveries + 1 })
            }
          }
        } catch (err) {
          if (!this.running) return
          const msg = (err as Error).message
          if (!msg.includes('NOGROUP')) logger.warn({ err: msg, group, stream }, 'reclaim loop error')
        }
      }
    }
  }

  private async process(message: StreamMessage): Promise<void> {
    const { group, consumer } = this.options
    this.inFlight.add(message.id)
    const heartbeat = setInterval(() => {
      this.client.xclaim(message.stream, group, consumer, 0, message.id, 'JUSTID').catch(() => undefined)
    }, Math.max(200, Math.floor(config.streams.claimBaseMs / 2)))
    try {
      const type = message.fields.type
      const skip = this.options.types && type !== undefined && !this.options.types.includes(type)
      if (!skip) await this.options.handle(message)
      this.options.beforeAck?.(message)
      await this.client.xack(message.stream, group, message.id)
      consumerMessages.inc({ group, outcome: 'acked' })
    } catch (err) {
      const decision = decide(err, message.deliveries)
      if (decision === 'dead_letter') {
        await this.deadLetter(message, isPermanent(err) ? 'permanent' : 'max_deliveries', (err as Error).message)
      } else {
        consumerMessages.inc({ group, outcome: 'failed' })
        logger.warn({ group, id: message.id, deliveries: message.deliveries, err: (err as Error).message }, 'handler failed, will retry')
      }
    } finally {
      clearInterval(heartbeat)
      this.inFlight.delete(message.id)
    }
  }

  private async deadLetter(message: StreamMessage, reason: string, error: string): Promise<void> {
    const { group } = this.options
    await xaddEvent(this.client, config.streams.deadLetter, {
      source_stream: message.stream,
      source_id: message.id,
      group,
      reason,
      error: error.slice(0, 500),
      deliveries: String(message.deliveries),
      dead_at: new Date().toISOString(),
      event: message.fields.event ?? JSON.stringify(message.fields),
    })
    await this.client.xack(message.stream, group, message.id)
    deadLettered.inc({ group, reason })
    logger.warn({ group, id: message.id, reason, error }, 'message dead-lettered')
  }
}

function toObject(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1]
  return out
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
