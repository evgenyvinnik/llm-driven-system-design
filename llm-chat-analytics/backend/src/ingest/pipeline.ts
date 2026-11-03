/**
 * The ingest decisions, free of I/O so they can be tested directly:
 * validate → re-stamp clock skew → reject too-late → dedup by event_id →
 * classify late against the stream watermark → enrich (local date, cost).
 * @module ingest/pipeline
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { type ChatEvent, streamOf, validateEvent } from '../shared/contract.js'
import { localDate } from '../shared/time.js'
import type { Watermarks } from '../shared/watermark.js'

export interface OrgInfo {
  timeZone: string
}

export interface Price {
  model: string
  effectiveFrom: number
  inputMicrosPerMTok: number
  outputMicrosPerMTok: number
}

export interface PrepareContext {
  orgs: Map<string, OrgInfo>
  /** Sorted by effectiveFrom descending within each model. */
  prices: Price[]
  watermarks: Watermarks
  maxLatenessMs?: number
  maxClockSkewMs?: number
}

/** Row shape for chat_analytics.events (JSONEachRow). */
export interface EventRow {
  event_id: string
  schema_version: number
  event_type: string
  source: string
  org_id: string
  user_id: string
  conversation_id: string
  generation_id: string
  event_time: string
  received_time: string
  local_date: string
  org_tz: string
  model: string
  feature: string
  platform: string
  ttft_ms: number
  latency_ms: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  error_code: string
  abandon_reason: string
  lateness_ms: number
  is_late: number
}

export interface RejectedRow {
  reason: string
  detail: string
  event_id: string
  org_id: string
  event_type: string
  kafka_partition: number
  kafka_offset: number
}

export type Prepared =
  | { kind: 'reject'; reason: string; detail: string; event?: ChatEvent }
  | { kind: 'accept'; row: EventRow; late: boolean; receivedAt: number }

/** ClickHouse DateTime64(3) literal in UTC. */
function chTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

export function costMicros(prices: Price[], model: string, at: number, input: number, output: number): number {
  const price = prices.find((p) => p.model === model && p.effectiveFrom <= at)
  if (!price) return 0
  return Math.round((input * price.inputMicrosPerMTok + output * price.outputMicrosPerMTok) / 1_000_000)
}

export function prepareEvent(event: ChatEvent, ctx: PrepareContext): Prepared {
  const org = ctx.orgs.get(event.org_id)
  if (!org) return { kind: 'reject', reason: 'unknown_org', detail: `org ${event.org_id} is not configured`, event }

  const receivedAt = Date.parse(event.received_time)
  let eventAt = Date.parse(event.event_time)
  // A device clock running ahead would put events in buckets that haven't
  // happened yet; trust the collector's receipt time instead.
  if (eventAt > receivedAt + (ctx.maxClockSkewMs ?? config.maxClockSkewMs)) eventAt = receivedAt

  const lateness = Math.max(0, receivedAt - eventAt)
  if (lateness > (ctx.maxLatenessMs ?? config.maxLatenessMs)) {
    return { kind: 'reject', reason: 'too_late', detail: `arrived ${Math.round(lateness / 3_600_000)}h after it happened`, event }
  }

  const watermark = ctx.watermarks[streamOf(event.event_type)]
  const late = watermark !== null && eventAt < watermark
  const input = event.input_tokens ?? 0
  const output = event.output_tokens ?? 0

  return {
    kind: 'accept',
    late,
    receivedAt,
    row: {
      event_id: event.event_id,
      schema_version: event.schema_version,
      event_type: event.event_type,
      source: event.source,
      org_id: event.org_id,
      user_id: event.user_id,
      conversation_id: event.conversation_id,
      generation_id: event.generation_id ?? '',
      event_time: chTime(eventAt),
      received_time: chTime(receivedAt),
      local_date: localDate(eventAt, org.timeZone),
      org_tz: org.timeZone,
      model: event.model,
      feature: event.feature,
      platform: event.platform ?? '',
      ttft_ms: event.ttft_ms ?? 0,
      latency_ms: event.latency_ms ?? 0,
      input_tokens: input,
      output_tokens: output,
      cost_micros: costMicros(ctx.prices, event.model, eventAt, input, output),
      error_code: event.error_code ?? '',
      abandon_reason: event.abandon_reason ?? '',
      lateness_ms: lateness,
      is_late: late ? 1 : 0,
    },
  }
}

/**
 * Dedup claims. `claimMany` sets each key only if absent and returns, per key,
 * null when this call claimed it, or the value already there.
 */
export interface DedupStore {
  claimMany(items: { key: string; value: string }[], ttlSeconds: number): Promise<(string | null)[]>
}

export class RedisDedupStore implements DedupStore {
  constructor(private readonly redis: Redis) {}

  async claimMany(items: { key: string; value: string }[], ttlSeconds: number): Promise<(string | null)[]> {
    if (items.length === 0) return []
    const pipeline = this.redis.pipeline()
    // SET ... NX GET (Redis/Valkey 7+): set if absent, and return the previous value either way.
    for (const { key, value } of items) pipeline.call('SET', key, value, 'EX', ttlSeconds, 'NX', 'GET')
    const results = (await pipeline.exec()) ?? []
    return results.map(([err, value]) => {
      if (err) throw err
      return (value as string | null) ?? null
    })
  }
}

export class MemoryDedupStore implements DedupStore {
  readonly claims = new Map<string, string>()

  async claimMany(items: { key: string; value: string }[]): Promise<(string | null)[]> {
    return items.map(({ key, value }) => {
      const existing = this.claims.get(key)
      if (existing !== undefined) return existing
      this.claims.set(key, value)
      return null
    })
  }
}

export interface BatchMessage {
  partition: number
  offset: string
  value: Buffer | string | null
}

export interface BatchResult {
  rows: EventRow[]
  rejected: RejectedRow[]
  duplicates: number
  /** Messages at or below the partition's inserted-through offset: already in ClickHouse from a run that crashed before committing. */
  alreadyInserted: number
  late: number
  /** org_id → org-local dates whose buckets the late rows changed. */
  lateDays: Map<string, Set<string>>
  /** Largest received_time among valid messages, or null if none. */
  maxReceivedAt: number | null
  firstOffset: number
  lastOffset: number
}

/**
 * Turns one chunk of Kafka messages (one partition, ascending offsets) into
 * ClickHouse rows. A message whose event_id is already claimed by a different
 * message is a duplicate; a claim by this same message means Kafka redelivered
 * it after a crash, so it is kept (and the insert token dedups it if its rows
 * already made it into ClickHouse).
 */
export async function processBatch(
  messages: BatchMessage[],
  deps: { dedup: DedupStore; ctx: PrepareContext; insertedThrough: number; dedupTtlSeconds?: number; keyFor?: (id: string) => string },
): Promise<BatchResult> {
  const result: BatchResult = {
    rows: [],
    rejected: [],
    duplicates: 0,
    alreadyInserted: 0,
    late: 0,
    lateDays: new Map(),
    maxReceivedAt: null,
    firstOffset: messages.length ? Number(messages[0].offset) : -1,
    lastOffset: messages.length ? Number(messages[messages.length - 1].offset) : -1,
  }
  const keyFor = deps.keyFor ?? ((id: string) => `dedup:${id}`)
  const candidates: { prepared: Extract<Prepared, { kind: 'accept' }>; claim: string }[] = []

  for (const msg of messages) {
    const offset = Number(msg.offset)
    if (offset <= deps.insertedThrough) {
      result.alreadyInserted++
      continue
    }
    const validation = validateEvent(msg.value)
    if (!validation.ok) {
      result.rejected.push({ reason: validation.reason, detail: validation.detail, event_id: '', org_id: '', event_type: '', kafka_partition: msg.partition, kafka_offset: offset })
      continue
    }
    const prepared = prepareEvent(validation.event, deps.ctx)
    if (prepared.kind === 'reject') {
      result.rejected.push({
        reason: prepared.reason,
        detail: prepared.detail,
        event_id: validation.event.event_id,
        org_id: validation.event.org_id,
        event_type: validation.event.event_type,
        kafka_partition: msg.partition,
        kafka_offset: offset,
      })
      continue
    }
    result.maxReceivedAt = Math.max(result.maxReceivedAt ?? 0, prepared.receivedAt)
    candidates.push({ prepared, claim: `${msg.partition}:${offset}` })
  }

  const existing = await deps.dedup.claimMany(
    candidates.map((c) => ({ key: keyFor(c.prepared.row.event_id), value: c.claim })),
    deps.dedupTtlSeconds ?? config.dedupTtlSeconds,
  )

  candidates.forEach((c, i) => {
    const owner = existing[i]
    if (owner !== null && owner !== c.claim) {
      result.duplicates++
      return
    }
    result.rows.push(c.prepared.row)
    if (c.prepared.late) {
      result.late++
      const { org_id, local_date } = c.prepared.row
      if (!result.lateDays.has(org_id)) result.lateDays.set(org_id, new Set())
      result.lateDays.get(org_id)!.add(local_date)
    }
  })
  return result
}
