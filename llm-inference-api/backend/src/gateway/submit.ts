/**
 * Request submission: validate, estimate cost, admit, record, enqueue.
 *
 *   1. Validate the Messages-API body; estimate input tokens; cost = input + max_tokens.
 *   2. Idempotency-Key: a live or completed request with the same key is returned instead.
 *   3. Pre-check (read-only Lua): would admission pass? Most rejections stop
 *      here, so a tenant hammering past its limit costs Valkey reads only,
 *      never a PostgreSQL write.
 *   4. Insert the durable record (status queued). The edge assigned the id.
 *   5. Admit (atomic Lua): re-check, charge both buckets, enqueue. If the
 *      pre-check raced and admission now fails, the record is marked failed.
 * @module gateway/submit
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { limitsPerMinute, retryAfterSeconds } from '../shared/bucket.js'
import { countStat, keys, runScript, type PriorityClass } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { ApiError } from '../shared/errors.js'
import { admissions } from '../shared/metrics.js'
import { transition, type Job, type RequestMode, type RequestRow } from '../shared/requests.js'
import { getRuntimeConfig } from '../shared/runtime-config.js'
import { estimateTokens, sha } from '../shared/tokens.js'
import type { Principal } from './principal.js'

export const MODELS = [{ id: 'mock-large', displayName: 'Mock Large', contextWindow: 32_000 }]

const textBlock = z.object({ type: z.literal('text'), text: z.string() })
const content = z.union([z.string().min(1), z.array(textBlock).min(1)])

export const messageBodySchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content })).min(1),
  stream: z.boolean().optional(),
  priority: z.enum(['interactive', 'batch']).optional(),
  metadata: z
    .object({
      user_id: z.string().max(256).optional(),
      /** Relative deadline: the request is dropped if it is still queued after this long. */
      deadline_ms: z.number().int().min(100).max(86_400_000).optional(),
      /** Mock-only knob: the mock model's natural output length. */
      mock_output_tokens: z.number().int().min(1).max(8192).optional(),
    })
    .optional(),
})

export type MessageBody = z.infer<typeof messageBodySchema>

const textOf = (c: string | { text: string }[] | undefined): string => (c === undefined ? '' : typeof c === 'string' ? c : c.map((b) => b.text).join('\n'))

export function newRequestId(): string {
  return `req_${randomBytes(12).toString('base64url')}`
}

export interface Estimate {
  inputTokens: number
  cost: number
  prefixKey: string
  prefixTokens: number
  seed: string
}

/**
 * Input tokens are estimated precisely enough; the expensive unknown is output,
 * so the reservation is input + max_tokens. The prefix key is what routing
 * affinity hashes: the system prompt (the part apps repeat), or the start of
 * the first message when there is no system prompt.
 */
export function estimate(body: MessageBody): Estimate {
  const system = textOf(body.system)
  const msgs = body.messages.map((m) => textOf(m.content))
  const inputTokens = (system ? estimateTokens(system) : 0) + msgs.reduce((n, t) => n + estimateTokens(t) + 4, 0)
  const prefixSource = system || msgs[0].slice(0, 2000)
  return {
    inputTokens,
    cost: inputTokens + body.max_tokens,
    prefixKey: sha(`${body.model}|${prefixSource}`),
    prefixTokens: estimateTokens(prefixSource),
    seed: sha(`${system}|${msgs.join('|')}`, 24),
  }
}

type AdmitOutcome = 'ok' | 'too_large' | 'rate_limited_tokens' | 'rate_limited_requests' | 'tenant_queue_full' | 'overloaded'

function rejection(outcome: AdmitOutcome, retryAfterMs: number, p: Principal, cls: PriorityClass, cost: number): ApiError {
  switch (outcome) {
    case 'too_large':
      return new ApiError(400, 'invalid_request_error', `This request reserves ${cost} tokens (input + max_tokens), more than your tier's ${p.tokensPerMinute} tokens per minute. Lower max_tokens.`)
    case 'rate_limited_tokens':
      return new ApiError(429, 'rate_limit_error', `Token rate limit for ${p.orgName} (${p.tokensPerMinute} tokens/min) exceeded: this request reserves ${cost} tokens.`, { 'retry-after': String(retryAfterSeconds(retryAfterMs)) })
    case 'rate_limited_requests':
      return new ApiError(429, 'rate_limit_error', `Request rate limit for ${p.orgName} (${p.requestsPerMinute} requests/min) exceeded.`, { 'retry-after': String(retryAfterSeconds(retryAfterMs)) })
    case 'tenant_queue_full':
      return new ApiError(429, 'rate_limit_error', `${p.orgName} already has its maximum number of queued ${cls} requests.`, { 'retry-after': String(retryAfterSeconds(retryAfterMs)) })
    case 'overloaded':
      return new ApiError(529, 'overloaded_error', `The ${cls} queue is full. The service is over capacity; retry with backoff.`, { 'retry-after': String(2 + Math.floor(Math.random() * 3)) })
    default:
      return new ApiError(500, 'api_error', 'Unexpected admission outcome')
  }
}

export interface Submitted {
  row: RequestRow
  /** True when an Idempotency-Key matched an existing request. */
  replayed: boolean
}

export async function submit(p: Principal, rawBody: unknown, mode: RequestMode, idempotencyKey: string | null): Promise<Submitted> {
  const body = messageBodySchema.parse(rawBody)
  if (!MODELS.some((m) => m.id === body.model)) throw new ApiError(404, 'not_found_error', `model: ${body.model}`)
  if (body.max_tokens > config.gateway.maxTokensCap) throw new ApiError(400, 'invalid_request_error', `max_tokens must be at most ${config.gateway.maxTokensCap}`)
  if (idempotencyKey && idempotencyKey.length > 255) throw new ApiError(400, 'invalid_request_error', 'Idempotency-Key is too long')

  if (idempotencyKey) {
    const { rows } = await pool.query<RequestRow>(
      `SELECT * FROM requests WHERE org_id = $1 AND idempotency_key = $2 AND status NOT IN ('cancelled', 'failed')`,
      [p.orgId, idempotencyKey],
    )
    if (rows[0]) return { row: rows[0], replayed: true }
  }

  const cls: PriorityClass = body.priority ?? (mode === 'async' ? 'batch' : 'interactive')
  const est = estimate(body)
  const now = Date.now()
  const deadlineAt = now + (mode === 'async' ? (body.metadata?.deadline_ms ?? 3_600_000) : Math.min(body.metadata?.deadline_ms ?? Infinity, config.gateway.syncTimeoutMs))
  const id = newRequestId()
  const tok = limitsPerMinute(p.tokensPerMinute)
  const req = limitsPerMinute(p.requestsPerMinute)
  const rc = await getRuntimeConfig()
  const job: Job = {
    id,
    orgId: p.orgId,
    keyId: p.keyId,
    cls,
    mode,
    weight: p.weight,
    cost: est.cost,
    inputTokens: est.inputTokens,
    maxTokens: body.max_tokens,
    prefixKey: est.prefixKey,
    prefixTokens: est.prefixTokens,
    seed: est.seed,
    outputTokens: body.metadata?.mock_output_tokens,
    enqueuedAt: now,
    deadlineAt,
    ratePerMs: tok.ratePerMs,
    capacity: tok.capacity,
  }
  const scriptKeys = [keys.tokenBucket(p.orgId), keys.requestBucket(p.orgId), keys.tenantQueue(cls, p.orgId), keys.tenants(cls), keys.age(cls), keys.deadline(cls), keys.job(id)]
  const args = (dry: boolean) => [
    Date.now(), est.cost, tok.ratePerMs, tok.capacity, req.ratePerMs, req.capacity,
    cls === 'interactive' ? p.maxQueuedInteractive : p.maxQueuedBatch,
    cls === 'interactive' ? rc.interactiveQueueLimit : rc.batchQueueLimit,
    id, p.orgId, deadlineAt, JSON.stringify(job), Math.ceil((deadlineAt - now) / 1000) + 3600, dry ? 1 : 0,
  ]

  const [pre, preRetry] = await runScript<[AdmitOutcome, number, number]>('ADMIT', scriptKeys, args(true))
  if (pre !== 'ok') {
    admissions.inc({ class: cls, outcome: pre })
    void countStat(p.orgId, pre).catch(() => undefined)
    throw rejection(pre, preRetry, p, cls, est.cost)
  }

  let row: RequestRow
  {
    const input = { system: body.system ?? null, messages: body.messages, metadata: body.metadata ?? null }
    const { rows } = await pool.query<RequestRow>(
      `INSERT INTO requests (id, org_id, api_key_id, model, mode, priority_class, max_tokens, est_input_tokens, est_cost_tokens,
         prefix_key, prefix_tokens, idempotency_key, input, deadline_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, to_timestamp($14 / 1000.0), to_timestamp($15 / 1000.0))
       ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND status NOT IN ('cancelled', 'failed') DO NOTHING
       RETURNING *`,
      [id, p.orgId, p.keyId, body.model, mode, cls, body.max_tokens, est.inputTokens, est.cost, est.prefixKey, est.prefixTokens, idempotencyKey, JSON.stringify(input), deadlineAt, now],
    )
    if (!rows[0]) {
      // Lost an idempotency race with a concurrent retry: return the winner.
      const { rows: existing } = await pool.query<RequestRow>(
        `SELECT * FROM requests WHERE org_id = $1 AND idempotency_key = $2 AND status NOT IN ('cancelled', 'failed')`,
        [p.orgId, idempotencyKey],
      )
      if (existing[0]) return { row: existing[0], replayed: true }
      throw new ApiError(409, 'conflict_error', 'Idempotency conflict, retry')
    }
    row = rows[0]
  }

  const [outcome, retryMs] = await runScript<[AdmitOutcome, number, number]>('ADMIT', scriptKeys, args(false))
  admissions.inc({ class: cls, outcome })
  void countStat(p.orgId, outcome === 'ok' ? 'admitted' : outcome).catch(() => undefined)
  if (outcome !== 'ok') {
    await transition(pool, id, 'failed', { error_type: outcome === 'overloaded' ? 'overloaded_error' : 'rate_limit_error', error_message: `rejected at admission: ${outcome}`, finished_at: new Date() })
    throw rejection(outcome, retryMs, p, cls, est.cost)
  }
  return { row, replayed: false }
}
