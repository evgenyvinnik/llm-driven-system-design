/**
 * The durable request record: insert, guarded state transitions, the job
 * payload that travels through the queue, per-request event log helpers,
 * usage finalization with the token refund, and DTO mapping.
 * @module shared/requests
 */
import type { Redis } from 'ioredis'
import { refundAmount } from './bucket.js'
import { keys, redis, runScript, type PriorityClass } from './cache.js'
import { pool, type Queryable } from './db.js'
import { sourcesOf, type RequestStatus } from './state-machine.js'

export type RequestMode = 'sync' | 'stream' | 'async'

/** What the dispatcher needs, copied into Valkey at admission so dispatch never reads PostgreSQL first. */
export interface Job {
  id: string
  orgId: string
  keyId: string
  cls: PriorityClass
  mode: RequestMode
  weight: number
  /** Reserved tokens: estimated input + max_tokens. */
  cost: number
  inputTokens: number
  maxTokens: number
  prefixKey: string
  prefixTokens: number
  seed: string
  outputTokens?: number
  enqueuedAt: number
  deadlineAt: number
  /** Token bucket limits for the refund. */
  ratePerMs: number
  capacity: number
}

export interface RequestRow {
  id: string
  org_id: string
  api_key_id: string
  model: string
  mode: RequestMode
  priority_class: PriorityClass
  status: RequestStatus
  max_tokens: number
  est_input_tokens: number
  est_cost_tokens: number
  prefix_key: string
  prefix_tokens: number
  idempotency_key: string | null
  input: unknown
  output_text: string | null
  stop_reason: string | null
  error_type: string | null
  error_message: string | null
  cancel_reason: string | null
  backend_id: string | null
  model_version: string | null
  batch_id: string | null
  attempts: number
  affinity: string | null
  deadline_at: Date
  created_at: Date
  dispatched_at: Date | null
  first_token_at: Date | null
  finished_at: Date | null
}

export interface UsageRow {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reserved_tokens: number
  refunded_tokens: number
  queue_ms: number | null
  ttft_ms: number | null
  exec_ms: number | null
  total_ms: number | null
  tokens_per_sec: number | null
}

const COLUMNS = new Set([
  'output_text', 'stop_reason', 'error_type', 'error_message', 'cancel_reason', 'backend_id', 'model_version',
  'batch_id', 'affinity', 'dispatched_at', 'first_token_at', 'finished_at',
])

/**
 * One guarded transition: `UPDATE ... WHERE id = $1 AND status = ANY(sources)`.
 * Returns the updated row if this call won, or null if the request was already
 * elsewhere (another transition won the race, or it never was in a source state).
 */
export async function transition(
  db: Queryable,
  id: string,
  to: RequestStatus,
  fields: Record<string, unknown> = {},
  orgId?: string,
): Promise<RequestRow | null> {
  const sets = ['status = $2']
  const values: unknown[] = [id, to, sourcesOf(to)]
  for (const [k, v] of Object.entries(fields)) {
    if (!COLUMNS.has(k)) throw new Error(`transition: unknown column ${k}`)
    values.push(v)
    sets.push(`${k} = $${values.length}`)
  }
  let where = 'id = $1 AND status = ANY($3::text[])'
  if (orgId) {
    values.push(orgId)
    where += ` AND org_id = $${values.length}`
  }
  const { rows } = await db.query<RequestRow>(`UPDATE requests SET ${sets.join(', ')} WHERE ${where} RETURNING *`, values)
  return rows[0] ?? null
}

export async function getRequest(db: Queryable, id: string, orgIds?: string[]): Promise<RequestRow | null> {
  const { rows } = orgIds
    ? await db.query<RequestRow>('SELECT * FROM requests WHERE id = $1 AND org_id = ANY($2::uuid[])', [id, orgIds])
    : await db.query<RequestRow>('SELECT * FROM requests WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function getUsage(db: Queryable, id: string): Promise<UsageRow | null> {
  const { rows } = await db.query<UsageRow>('SELECT * FROM usage WHERE request_id = $1', [id])
  return rows[0] ?? null
}

// ── Event log ────────────────────────────────────────────────────────────────

export type RequestEventType = 'start' | 'delta' | 'requeued' | 'done' | 'error' | 'cancelled'
export const TERMINAL_EVENTS = new Set<RequestEventType>(['done', 'error', 'cancelled'])
const EVENT_TTL_SECONDS = 3600

export function appendEvent(id: string, type: RequestEventType, data: Record<string, unknown>, client: Redis = redis) {
  return client.multi().xadd(keys.events(id), 'MAXLEN', '~', '5000', '*', 'e', type, 'd', JSON.stringify(data)).expire(keys.events(id), EVENT_TTL_SECONDS).exec()
}

// ── Usage and refund ─────────────────────────────────────────────────────────

export interface UsageFacts {
  status: RequestStatus
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  queueMs: number | null
  ttftMs: number | null
  execMs: number | null
  totalMs: number | null
  tokensPerSec: number | null
}

/**
 * Writes the usage row once and refunds the unused reservation. The refund
 * runs only if this call inserted the row, so a request is refunded at most
 * once even if two components try to finalize it.
 */
export async function finalizeUsage(job: Job, facts: UsageFacts, db: Queryable = pool): Promise<boolean> {
  const billed = facts.inputTokens + facts.outputTokens
  const refund = refundAmount(job.cost, billed)
  const { rowCount } = await db.query(
    `INSERT INTO usage (request_id, org_id, api_key_id, priority_class, status, input_tokens, cached_input_tokens,
       output_tokens, reserved_tokens, refunded_tokens, queue_ms, ttft_ms, exec_ms, total_ms, tokens_per_sec)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (request_id) DO NOTHING`,
    [job.id, job.orgId, job.keyId, job.cls, facts.status, facts.inputTokens, facts.cachedTokens, facts.outputTokens, job.cost, refund,
      facts.queueMs, facts.ttftMs, facts.execMs, facts.totalMs, facts.tokensPerSec],
  )
  if (!rowCount) return false
  if (refund > 0) await runScript('REFUND', [keys.tokenBucket(job.orgId)], [Date.now(), refund, job.ratePerMs, job.capacity])
  return true
}

/** Full refund for work that never reached a backend (cancelled or expired in the queue). */
export function finalizeUnstarted(job: Job, status: RequestStatus, db: Queryable = pool): Promise<boolean> {
  const totalMs = Date.now() - job.enqueuedAt
  return finalizeUsage(job, { status, inputTokens: 0, cachedTokens: 0, outputTokens: 0, queueMs: totalMs, ttftMs: null, execMs: null, totalMs, tokensPerSec: null }, db)
}

export async function loadJob(id: string, client: Redis = redis): Promise<Job | null> {
  const raw = await client.get(keys.job(id))
  return raw ? (JSON.parse(raw) as Job) : null
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toUsageDto(u: UsageRow | null) {
  if (!u) return null
  return {
    inputTokens: u.input_tokens,
    cachedInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens,
    reservedTokens: u.reserved_tokens,
    refundedTokens: u.refunded_tokens,
    queueMs: u.queue_ms,
    ttftMs: u.ttft_ms,
    execMs: u.exec_ms,
    totalMs: u.total_ms,
    tokensPerSec: u.tokens_per_sec === null ? null : Math.round(u.tokens_per_sec * 10) / 10,
  }
}

/** Console DTO (camelCase). */
export function toRequestDto(r: RequestRow, usage: UsageRow | null = null, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    orgId: r.org_id,
    apiKeyId: r.api_key_id,
    model: r.model,
    mode: r.mode,
    priorityClass: r.priority_class,
    status: r.status,
    maxTokens: r.max_tokens,
    estimatedInputTokens: r.est_input_tokens,
    reservedTokens: r.est_cost_tokens,
    prefixKey: r.prefix_key,
    input: r.input,
    outputText: r.output_text,
    stopReason: r.stop_reason,
    error: r.error_type ? { type: r.error_type, message: r.error_message } : null,
    cancelReason: r.cancel_reason,
    backendId: r.backend_id,
    modelVersion: r.model_version,
    batchId: r.batch_id,
    attempts: r.attempts,
    affinity: r.affinity,
    createdAt: iso(r.created_at),
    dispatchedAt: iso(r.dispatched_at),
    firstTokenAt: iso(r.first_token_at),
    finishedAt: iso(r.finished_at),
    deadlineAt: iso(r.deadline_at),
    usage: toUsageDto(usage),
    ...extra,
  }
}

/** Public API shape (snake_case, Messages-API style) for GET /v1/requests/:id. */
export function toPublicRequest(r: RequestRow, usage: UsageRow | null) {
  const u = toUsageDto(usage)
  return {
    id: r.id,
    type: 'request',
    status: r.status,
    mode: r.mode,
    priority: r.priority_class,
    model: r.model,
    model_version: r.model_version,
    created_at: iso(r.created_at),
    finished_at: iso(r.finished_at),
    result:
      r.status === 'completed' || (r.status === 'cancelled' && r.output_text)
        ? {
            id: r.id,
            type: 'message',
            role: 'assistant',
            model: r.model,
            content: [{ type: 'text', text: r.output_text ?? '' }],
            stop_reason: r.status === 'cancelled' ? 'cancelled' : r.stop_reason,
            stop_sequence: null,
            usage: u ? { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cachedInputTokens } : null,
          }
        : null,
    error: r.error_type ? { type: r.error_type, message: r.error_message } : null,
    cancel_reason: r.cancel_reason,
    latency: u ? { queue_ms: u.queueMs, ttft_ms: u.ttftMs, exec_ms: u.execMs, total_ms: u.totalMs, tokens_per_sec: u.tokensPerSec } : null,
    usage: u ? { input_tokens: u.inputTokens, cache_read_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens, reserved_tokens: u.reservedTokens, refunded_tokens: u.refundedTokens } : null,
  }
}
