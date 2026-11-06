/**
 * Consumer-group runtime shared by the analyzer, the integrations, the process
 * manager and the projections.
 *
 * Delivery is at-least-once (the relay can republish, a consumer can die after
 * committing but before XACK). Effects are exactly-once because each message is
 * handled in one PostgreSQL transaction that:
 *   1. inserts (group, event_id) into processed_events: a duplicate inserts nothing and is acked as a no-op;
 *   2. runs the handler (its reads, state writes and any new events, staged in an EventBatch);
 *   3. advances the group's checkpoint for that stream;
 *   4. commits. Only then is the message XACKed.
 *
 * Failures: a permanent error (bad JSON, schema violation, unknown schema
 * version) goes to the dead-letter stream at once. A transient error leaves the
 * message pending; the reclaim loop retries it after claimIdleMs, and after
 * maxDeliveries it is dead-lettered. Either way the group keeps moving.
 * @module events/consumer
 */
import type { Redis } from 'ioredis'
import { ZodError } from 'zod'
import { config } from '../shared/config.js'
import { publishEvents, type LiveEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { consumerEvents, consumerHandleSeconds, streamRedeliveries } from '../shared/metrics.js'
import { fieldsToObject, streamKey } from '../shared/stream.js'
import { validatePayload } from './catalog.js'
import { deadLetter, type DeadLetter } from './dlq.js'
import { toEnvelope, UnknownSchemaVersionError, type EventEnvelope, type StoredEventRow } from './envelope.js'
import { getFault, SimulatedFault, type Fault } from './faults.js'
import { withEventTransaction, type AppendContext, type EventTx } from './store.js'
import type { GroupSpec } from './topology.js'

export interface ConsumerTx extends EventTx {
  group: string
  streamKey: string
  messageId: string
}

export type Handler = (event: EventEnvelope, tx: ConsumerTx) => Promise<{ notices?: LiveEvent[] } | void>

export class PermanentError extends Error {
  readonly permanent = true
}

export type Outcome = 'processed' | 'duplicate' | 'skipped' | 'failed' | 'dead_lettered'

export interface RuntimeDeps {
  transaction: <T>(ctx: AppendContext, fn: (tx: EventTx) => Promise<T>) => Promise<{ result: T }>
  ack: (streamKey: string, id: string) => Promise<void>
  deadLetter: (d: DeadLetter) => Promise<void>
  fault: (group: string) => Promise<Fault | null>
  publish: (notices: LiveEvent[]) => Promise<void>
  maxDeliveries: number
  /** Simulated crash (fault mode crash_after_commit): the default kills the process without acking. */
  crash?: (reason: string) => void
}

export interface Delivery {
  streamKey: string
  id: string
  fields: string[]
  /** 1 on first delivery; the broker's delivery count on a reclaim. */
  deliveries: number
}

const isPermanent = (err: unknown) =>
  err instanceof ZodError || err instanceof SyntaxError || err instanceof UnknownSchemaVersionError || (err as { permanent?: boolean })?.permanent === true

/**
 * Handles one broker message for one group. Pure with respect to its dependencies, so the
 * idempotency, retry and dead-letter rules are unit-tested without Valkey or PostgreSQL.
 */
export async function processDelivery(deps: RuntimeDeps, spec: GroupSpec, handler: Handler, d: Delivery): Promise<Outcome> {
  const f = fieldsToObject(d.fields)
  if (f.redriveFor && f.redriveFor !== spec.group) {
    await deps.ack(d.streamKey, d.id)
    return 'skipped'
  }
  const type = f.type ?? ''
  if (type && !spec.handles.includes(type)) {
    await deps.ack(d.streamKey, d.id)
    return 'skipped'
  }
  let row: StoredEventRow | null = null
  const end = consumerHandleSeconds.startTimer({ group: spec.group })
  try {
    if (d.deliveries > deps.maxDeliveries) throw new PermanentError(`delivered ${d.deliveries - 1} times without completing`)
    row = JSON.parse(f.event ?? '') as StoredEventRow
    if (!spec.handles.includes(row.type)) {
      await deps.ack(d.streamKey, d.id)
      return 'skipped'
    }
    const event = toEnvelope(row)
    validatePayload(event.type, event.version, event.payload)
    const fault = await deps.fault(spec.group)
    const faultHit = fault !== null && (fault.match === '' || (f.event ?? '').includes(fault.match))
    if (faultHit && fault.mode !== 'crash_after_commit') throw new SimulatedFault(spec.group, fault)

    const ctx: AppendContext = { correlationId: event.correlationId, causationId: event.eventId, actor: spec.group }
    const { result } = await deps.transaction(ctx, async (tx) => {
      const fresh = await tx.client.query('INSERT INTO processed_events (group_name, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [spec.group, event.eventId])
      if (fresh.rowCount === 0) return { duplicate: true as const, notices: [] as LiveEvent[] }
      const out = await handler(event, { ...tx, group: spec.group, streamKey: d.streamKey, messageId: d.id })
      await tx.client.query(
        `INSERT INTO consumer_checkpoints (group_name, stream_key, last_position, last_message_id, events_handled, updated_at)
         VALUES ($1, $2, $3, $4, 1, now())
         ON CONFLICT (group_name, stream_key) DO UPDATE SET last_position = GREATEST(consumer_checkpoints.last_position, EXCLUDED.last_position),
           last_message_id = EXCLUDED.last_message_id, events_handled = consumer_checkpoints.events_handled + 1, updated_at = now()`,
        [spec.group, d.streamKey, event.globalPosition, d.id],
      )
      return { duplicate: false as const, notices: out?.notices ?? [] }
    })
    if (faultHit && !result.duplicate) {
      // Committed, not acked: the message stays pending and is redelivered after a restart.
      deps.crash?.(`simulated crash after committing ${row.type} ${row.event_id}, before XACK`)
      return 'failed'
    }
    await deps.ack(d.streamKey, d.id)
    if (result.notices.length > 0) await deps.publish(result.notices)
    consumerEvents.inc({ group: spec.group, outcome: result.duplicate ? 'duplicate' : 'processed' })
    return result.duplicate ? 'duplicate' : 'processed'
  } catch (err) {
    const permanent = isPermanent(err)
    if (permanent || d.deliveries >= deps.maxDeliveries) {
      await deps.deadLetter({
        group: spec.group, streamKey: d.streamKey, messageId: d.id, eventId: row?.event_id ?? '', type: row?.type ?? type, permanent,
        error: err instanceof ZodError ? `schema violation: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : (err as Error).message,
        attempts: d.deliveries, deadAt: new Date().toISOString(), event: f.event ?? '',
      })
      await deps.ack(d.streamKey, d.id)
      consumerEvents.inc({ group: spec.group, outcome: 'dead_lettered' })
      streamRedeliveries.inc({ group: spec.group, kind: 'dead_lettered' })
      logger.error({ group: spec.group, type: row?.type ?? type, id: d.id, deliveries: d.deliveries, permanent, err: (err as Error).message }, 'message dead-lettered')
      return 'dead_lettered'
    }
    consumerEvents.inc({ group: spec.group, outcome: 'failed' })
    logger.warn({ group: spec.group, type: row?.type ?? type, id: d.id, deliveries: d.deliveries, err: (err as Error).message }, 'message failed; left pending for retry')
    return 'failed'
  } finally {
    end()
  }
}

type StreamEntry = [id: string, fields: string[] | null]

export interface RunOptions {
  spec: GroupSpec
  handler: Handler
  redis: Redis
  shouldStop: () => boolean
  /** Messages per read, by family (the analyzer takes the backfill lane in small bites). */
  batchFor?: (family: string) => number
}

export function defaultDeps(redis: Redis, group: string): RuntimeDeps {
  return {
    transaction: (ctx, fn) => withEventTransaction(ctx, fn),
    ack: async (key, id) => {
      await redis.xack(key, group, id)
    },
    deadLetter: async (d) => {
      await deadLetter(redis, d)
    },
    fault: (group) => getFault(redis, group),
    publish: publishEvents,
    maxDeliveries: config.stream.maxDeliveries,
    crash: (reason) => {
      logger.fatal({ group, reason }, 'simulated crash')
      process.kill(process.pid, 'SIGKILL')
    },
  }
}

export async function ensureGroups(redis: Redis, group: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      // From the start of the stream: nothing published before this group existed is skipped.
      await redis.xgroup('CREATE', key, group, '0', 'MKSTREAM')
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err
    }
  }
}

/** Runs one consumer in a group until shouldStop. Several processes can run the same group. */
export async function runConsumerGroup(opts: RunOptions): Promise<void> {
  const { spec, handler, redis, shouldStop } = opts
  const group = spec.group
  const consumer = `${config.stream.consumer}`
  const keys = spec.families.map(streamKey)
  const deps = defaultDeps(redis, group)
  const batchFor = opts.batchFor ?? (() => 50)
  const handle = (key: string, entries: StreamEntry[], deliveries = 1) =>
    entries.reduce<Promise<void>>(async (prev, [id, fields]) => {
      await prev
      if (!fields) {
        await redis.xack(key, group, id) // trimmed from the stream
        return
      }
      await processDelivery(deps, spec, handler, { streamKey: key, id, fields, deliveries })
    }, Promise.resolve())

  const read = async (key: string, count: number, cursor: '0' | '>'): Promise<StreamEntry[]> => {
    const res = (await redis.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'STREAMS', key, cursor)) as Array<[string, StreamEntry[]]> | null
    return res?.[0]?.[1] ?? []
  }

  /** Retries messages idle past claimIdleMs (a crashed consumer's, or our own failures). */
  const reclaim = async (key: string) => {
    const pending = (await redis.xpending(key, group, 'IDLE', config.stream.claimIdleMs, '-', '+', 50)) as Array<[string, string, number, number]>
    for (const [id, , , deliveries] of pending) {
      const claimed = (await redis.xclaim(key, group, consumer, config.stream.claimIdleMs, id)) as StreamEntry[]
      if (!claimed[0]) {
        await redis.xack(key, group, id)
        continue
      }
      streamRedeliveries.inc({ group, kind: 'claimed' })
      await handle(key, claimed, deliveries + 1)
    }
  }

  await ensureGroups(redis, group, keys)
  // A restart after a crash: first finish whatever this consumer name already owns.
  for (const key of keys) await handle(key, await read(key, 1000, '0'))
  let lastReclaim = 0
  while (!shouldStop()) {
    try {
      if (Date.now() - lastReclaim > config.stream.claimIdleMs / 3) {
        lastReclaim = Date.now()
        for (const key of keys) await reclaim(key)
      }
      let handled = false
      for (const [i, key] of keys.entries()) {
        const entries = await read(key, batchFor(spec.families[i]), '>')
        if (entries.length > 0) {
          await handle(key, entries)
          handled = true
          break // start again from the highest-priority stream
        }
      }
      if (handled) continue
      const res = (await redis.xreadgroup(
        'GROUP', group, consumer, 'COUNT', 1, 'BLOCK', 1000, 'STREAMS', ...keys, ...keys.map(() => '>'),
      )) as Array<[string, StreamEntry[]]> | null
      for (const [key, entries] of res ?? []) await handle(key, entries)
    } catch (err) {
      if (shouldStop()) break
      const message = (err as Error).message
      // The streams were deleted (a reseed): recreate the groups and carry on.
      if (message.includes('NOGROUP')) await ensureGroups(redis, group, keys).catch(() => undefined)
      logger.error({ group, err: message }, 'consumer loop error')
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
