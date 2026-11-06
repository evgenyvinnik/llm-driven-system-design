/**
 * The partitioned consumer runner every consumer group uses.
 *
 * Delivery is at-least-once; effects are exactly-once because each message is handled inside one database
 * transaction that also inserts (group, event_id) into processed_events. A redelivered message hits the
 * primary key, the handler is skipped, and the message is acknowledged. The stream ack (XACK) happens only
 * after the transaction commits, so a crash between commit and ack produces a redelivery, never a loss.
 *
 * Partition ownership: a group's instance takes a lease per partition stream, like a Kafka assignment, so
 * one car's events are handled by one instance at a time. On startup it first re-reads its own pending
 * entries (id 0) to finish what it was doing when it stopped.
 *
 * Failures: a message that throws stays pending. After CLAIM_IDLE_MS it is reclaimed with XAUTOCLAIM and
 * retried; once its delivery count reaches MAX_DELIVERIES it is copied to the group's DLQ stream with the
 * last error and acknowledged. A failed message does not block later messages of its partition: every
 * handler here is order-tolerant (state is folded by event time), so we trade strict per-key order on the
 * failure path for not stalling a partition behind one poison message.
 * @module shared/consumer
 */
import express from 'express'
import type { PoolClient } from 'pg'
import type { Redis } from 'ioredis'
import { createRedisConnection, redis as sharedRedis } from './cache.js'
import { config, type Topic } from './config.js'
import { pool, withTransaction } from './db.js'
import { toEnvelope, fromWire, type AnyEnvelope, type EventRow } from './events/envelope.js'
import type { EventType } from './events/schemas.js'
import { logger } from './logger.js'
import { handlerSeconds, messagesHandled, metricsHandler } from './metrics.js'
import { dlqKey, ensureGroup, errorsKey, fieldsToObject, leaseKey, LEASE_SCRIPT, partitionStreams, RELEASE_SCRIPT, retryKey } from './streams.js'
import { startClockSync } from './clock.js'

export interface HandlerContext {
  tx: PoolClient
  group: string
  /** Work to run after the transaction commits (for example the saga's next step). */
  afterCommit(fn: () => Promise<void>): void
}

export interface ConsumerSpec {
  group: string
  topics: Topic[]
  /** Types this group handles; everything else on its topics is acknowledged and skipped. */
  types: EventType[]
  handle(event: AnyEnvelope, ctx: HandlerContext): Promise<void>
  /** Periodic work outside message handling (sweeps, digest flushes). */
  ticks?: Array<{ name: string; everyMs: number; run(): Promise<void> }>
  port: number
}

export type Outcome = 'processed' | 'duplicate' | 'skipped'

export interface ProcessDeps {
  withTx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T>
  /** True if this (group, event) was not processed before; the marker is part of the transaction. */
  markProcessed(tx: PoolClient, group: string, eventId: string): Promise<boolean>
  recordCheckpoint(tx: PoolClient, group: string, event: AnyEnvelope | null, duplicate: boolean): Promise<void>
}

export const pgDeps: ProcessDeps = {
  withTx: withTransaction,
  async markProcessed(tx, group, eventId) {
    const res = await tx.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [group, eventId])
    return res.rowCount === 1
  },
  async recordCheckpoint(tx, group, event, duplicate) {
    await tx.query(
      `INSERT INTO consumer_checkpoints (consumer, events_processed, duplicates, last_event_id, last_position, last_recorded_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (consumer) DO UPDATE SET
         events_processed = consumer_checkpoints.events_processed + EXCLUDED.events_processed,
         duplicates = consumer_checkpoints.duplicates + EXCLUDED.duplicates,
         last_event_id = COALESCE(EXCLUDED.last_event_id, consumer_checkpoints.last_event_id),
         last_position = COALESCE(EXCLUDED.last_position, consumer_checkpoints.last_position),
         last_recorded_at = COALESCE(EXCLUDED.last_recorded_at, consumer_checkpoints.last_recorded_at),
         updated_at = now()`,
      [group, duplicate ? 0 : 1, duplicate ? 1 : 0, duplicate ? null : event?.eventId, duplicate ? null : event?.position, duplicate ? null : event?.recordedAt],
    )
  },
}

/**
 * Handles one stored event for one group: skip types the group does not handle, otherwise run the handler
 * and the idempotency marker in one transaction. Pure orchestration, so it is unit-tested with fakes.
 */
export async function processMessage(
  spec: Pick<ConsumerSpec, 'group' | 'types' | 'handle'>,
  row: EventRow,
  deps: ProcessDeps,
): Promise<{ outcome: Outcome; after: Array<() => Promise<void>> }> {
  if (!spec.types.includes(row.type as EventType)) return { outcome: 'skipped', after: [] }
  // Upcasting happens before the transaction: an unknown version throws and the message is retried, then dead-lettered.
  const event = toEnvelope(row)
  const after: Array<() => Promise<void>> = []
  const outcome = await deps.withTx(async (tx) => {
    const fresh = await deps.markProcessed(tx, spec.group, event.eventId)
    if (!fresh) {
      await deps.recordCheckpoint(tx, spec.group, event, true)
      return 'duplicate' as const
    }
    await spec.handle(event, { tx, group: spec.group, afterCommit: (fn) => after.push(fn) })
    await deps.recordCheckpoint(tx, spec.group, event, false)
    return 'processed' as const
  })
  return { outcome, after: outcome === 'processed' ? after : [] }
}

/** Bounded retries: dead-letter once a message has been delivered `max` times. */
export function failureAction(deliveries: number, max: number = config.streams.maxDeliveries): 'retry' | 'dead_letter' {
  return deliveries >= max ? 'dead_letter' : 'retry'
}

export interface DeadLetterInput {
  group: string
  stream: string
  messageId: string
  fields: Record<string, string>
  error: string
  deliveries: number
}

type DlqClient = Pick<Redis, 'xadd' | 'xack' | 'hdel'>

/** Copies a message to the group's DLQ stream (with why it failed), then acknowledges the original. */
export async function deadLetter(client: DlqClient, input: DeadLetterInput): Promise<void> {
  await client.xadd(
    dlqKey(input.group),
    '*',
    'stream', input.stream,
    'messageId', input.messageId,
    'eventId', input.fields.id ?? '',
    'type', input.fields.type ?? '',
    'key', input.fields.key ?? '',
    'e', input.fields.e ?? '',
    'error', input.error.slice(0, 500),
    'deliveries', String(input.deliveries),
    'deadAt', new Date().toISOString(),
  )
  await client.xack(input.stream, input.group, input.messageId)
  await client.hdel(errorsKey(input.group), `${input.stream}|${input.messageId}`)
}

type StreamReply = Array<[string, Array<[string, string[] | null]>]> | null

export async function runConsumer(spec: ConsumerSpec): Promise<void> {
  const consumerName = process.env.CONSUMER_NAME || `${spec.group}-1`
  const log = logger.child({ group: spec.group, consumer: consumerName })
  const reader = createRedisConnection(`${spec.group}-reader`)
  const redis = sharedRedis
  const partitions = spec.topics.flatMap((t) => partitionStreams(t))
  const retry = retryKey(spec.group)
  for (const stream of [...partitions, retry]) await ensureGroup(redis, stream, spec.group)

  const owned = new Set<string>()
  const recoverPending = new Set<string>([retry])
  let running = true
  let lastReclaim = 0
  const stopClock = startClockSync(redis)

  async function refreshLeases(): Promise<void> {
    for (const stream of partitions) {
      const ok = (await redis.eval(LEASE_SCRIPT, 1, leaseKey(spec.group, stream), consumerName, String(config.streams.leaseMs))) as number
      if (ok === 1 && !owned.has(stream)) {
        owned.add(stream)
        recoverPending.add(stream)
        log.info({ stream }, 'partition assigned')
      } else if (ok !== 1 && owned.delete(stream)) {
        log.warn({ stream }, 'partition lease lost')
      }
    }
  }

  async function handle(stream: string, messageId: string, fields: Record<string, string>): Promise<void> {
    const end = handlerSeconds.startTimer({ group: spec.group })
    try {
      const { outcome, after } = await processMessage(spec, fromWire(fields.e), pgDeps)
      await redis.xack(stream, spec.group, messageId)
      messagesHandled.inc({ group: spec.group, outcome })
      for (const fn of after) await fn().catch((err) => log.warn({ err: (err as Error).message }, 'after-commit step failed; the sweeper will resume it'))
    } catch (err) {
      const message = (err as Error).message
      messagesHandled.inc({ group: spec.group, outcome: 'failed' })
      await redis.hset(errorsKey(spec.group), `${stream}|${messageId}`, message.slice(0, 500)).catch(() => undefined)
      log.warn({ stream, messageId, type: fields.type, key: fields.key, err: message }, 'message failed; will retry')
    } finally {
      end()
    }
  }

  /** Reclaims pending messages idle past CLAIM_IDLE_MS: retry, or dead-letter after MAX_DELIVERIES. */
  async function reclaim(): Promise<void> {
    for (const stream of [...owned, retry]) {
      const reply = (await redis.call('XAUTOCLAIM', stream, spec.group, consumerName, String(config.streams.claimIdleMs), '0-0', 'COUNT', '50')) as [string, Array<[string, string[]]>]
      for (const [messageId, raw] of reply[1] ?? []) {
        if (!raw) {
          await redis.xack(stream, spec.group, messageId)
          continue
        }
        const fields = fieldsToObject(raw)
        const pending = (await redis.xpending(stream, spec.group, messageId, messageId, 1)) as Array<[string, string, number, number]>
        const deliveries = pending[0]?.[3] ?? 1
        if (failureAction(deliveries) === 'dead_letter') {
          const error = (await redis.hget(errorsKey(spec.group), `${stream}|${messageId}`)) ?? 'unknown error'
          await deadLetter(redis, { group: spec.group, stream, messageId, fields, error, deliveries })
          messagesHandled.inc({ group: spec.group, outcome: 'dead_lettered' })
          log.error({ stream, messageId, type: fields.type, key: fields.key, deliveries, error }, 'message dead-lettered')
        } else {
          await handle(stream, messageId, fields)
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        if (Date.now() - lastReclaim >= config.streams.claimIdleMs) {
          lastReclaim = Date.now()
          await reclaim()
        }
        const streams = [...owned, retry]
        const ids = streams.map((s) => (recoverPending.has(s) ? '0' : '>'))
        const reply = (await reader.xreadgroup(
          'GROUP', spec.group, consumerName,
          'COUNT', config.streams.readCount,
          'BLOCK', config.streams.blockMs,
          'STREAMS', ...streams, ...ids,
        )) as StreamReply
        for (const s of streams) if (ids[streams.indexOf(s)] === '0') recoverPending.delete(s)
        for (const [stream, entries] of reply ?? []) {
          for (const [messageId, raw] of entries) {
            if (!running) break
            if (!raw) {
              await redis.xack(stream, spec.group, messageId)
              continue
            }
            await handle(stream, messageId, fieldsToObject(raw))
          }
        }
      } catch (err) {
        if (!running) break
        log.error({ err: (err as Error).message }, 'consumer loop error')
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  await refreshLeases()
  const leaseTimer = setInterval(() => void refreshLeases().catch((err) => log.warn({ err: err.message }, 'lease refresh failed')), Math.floor(config.streams.leaseMs / 3))
  const tickTimers = (spec.ticks ?? []).map((t) => {
    let busy = false
    return setInterval(() => {
      if (busy) return
      busy = true
      t.run()
        .catch((err) => log.warn({ tick: t.name, err: (err as Error).message }, 'tick failed'))
        .finally(() => {
          busy = false
        })
    }, t.everyMs)
  })

  const app = express()
  app.get('/health', (_req, res) => res.json({ status: 'ok', group: spec.group, consumer: consumerName, partitions: [...owned] }))
  app.get('/metrics', metricsHandler)
  const server = app.listen(spec.port, () => log.info({ port: spec.port, partitions: [...owned] }, 'consumer started'))

  const done = loop()

  async function shutdown(signal: string) {
    log.info({ signal }, 'shutting down')
    running = false
    clearInterval(leaseTimer)
    tickTimers.forEach(clearInterval)
    stopClock()
    await done.catch(() => undefined)
    // Hand partitions back immediately so a replacement does not wait for the lease to expire.
    for (const stream of owned) await redis.eval(RELEASE_SCRIPT, 1, leaseKey(spec.group, stream), consumerName).catch(() => undefined)
    server.close()
    reader.disconnect()
    await Promise.allSettled([pool.end(), redis.quit()])
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
