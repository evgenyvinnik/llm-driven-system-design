/**
 * Session store for turns. PostgreSQL holds each turn's state machine:
 *
 *   running ──▶ waiting_client ──▶ running ──▶ waiting_confirmation ──▶ running ──▶ completed
 *      │              (browser result)               (user confirms)                 failed
 *      └────────────────────────────────────────────────────────────────────────▶ cancelled
 *
 * A running turn is owned by one API instance through a lease. Every write
 * the owner makes is fenced on `lease_owner`, so an instance that stalled
 * and lost its lease can't overwrite the work of the instance that took over.
 * @module orchestrator/turn-store
 */
import { config } from '../shared/config.js'
import { pool, type Queryable } from '../shared/db.js'
import type { Source } from '../tools/types.js'
import type { MessageParam } from './model-client.js'

export type TurnStatus = 'running' | 'waiting_client' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled'
export const ACTIVE_STATUSES: TurnStatus[] = ['running', 'waiting_client', 'waiting_confirmation']

export interface BatchCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/** The tool calls of the latest assistant reply, and how far the turn got through them. */
export interface Batch {
  calls: BatchCall[]
  results: Record<string, { content: string; isError: boolean }>
  approved: string[]
  waiting?: { callId: string; kind: 'client' | 'confirmation'; actionId?: string }
}

export interface Turn {
  id: string
  conversation_id: string
  user_id: string
  seq: number
  request_hash: string
  user_text: string
  client_context: Record<string, unknown>
  status: TurnStatus
  messages: MessageParam[]
  batch: Batch | null
  tainted: boolean
  toolset_hash: string | null
  model: string | null
  steps: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  active_ms: number
  final_text: string | null
  citations: unknown[]
  sources: Record<string, Source>
  error_code: string | null
  error_message: string | null
  cancel_requested: boolean
  created_at: Date
  completed_at: Date | null
}

export class LeaseLostError extends Error {
  constructor(turnId: string) {
    super(`Lost the lease on turn ${turnId}`)
  }
}

export async function loadTurn(turnId: string, db: Queryable = pool): Promise<Turn | null> {
  const { rows } = await db.query<Turn>('SELECT * FROM turns WHERE id = $1', [turnId])
  return rows[0] ?? null
}

/**
 * Claims a turn for this instance. `from` lists the statuses it may be
 * claimed from; for a running turn the old lease must have expired.
 */
export async function claimTurn(turnId: string, from: TurnStatus[], owner = config.instanceId): Promise<Turn | null> {
  const { rows } = await pool.query<Turn>(
    `UPDATE turns SET status = 'running', lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3),
            waiting_since = NULL, updated_at = now()
      WHERE id = $1 AND status = ANY($4::text[])
        AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = $2)
      RETURNING *`,
    [turnId, owner, config.turn.leaseSeconds, from],
  )
  return rows[0] ?? null
}

export async function extendLease(turnId: string, owner = config.instanceId): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE turns SET lease_expires_at = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [turnId, owner, config.turn.leaseSeconds],
  )
  return (rowCount ?? 0) > 0
}

export type CheckpointFields = Partial<
  Pick<Turn, 'messages' | 'batch' | 'tainted' | 'toolset_hash' | 'model' | 'steps' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'sources'>
>

const JSON_FIELDS = new Set(['messages', 'batch', 'sources'])

/** Saves progress. Fenced on the lease; returns whether cancellation was requested meanwhile. */
export async function checkpoint(turnId: string, fields: CheckpointFields, owner = config.instanceId): Promise<{ cancelRequested: boolean }> {
  const entries = Object.entries(fields)
  const sets = entries.map(([key], i) => `${key} = $${i + 3}`)
  const values = entries.map(([key, value]) => (JSON_FIELDS.has(key) ? JSON.stringify(value) : value))
  const { rows } = await pool.query<{ cancel_requested: boolean }>(
    `UPDATE turns SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING cancel_requested`,
    [turnId, owner, ...values],
  )
  if (!rows[0]) throw new LeaseLostError(turnId)
  return { cancelRequested: rows[0].cancel_requested }
}

/** Saves the turn and frees the worker until the browser or the user answers. */
export async function suspend(turnId: string, status: 'waiting_client' | 'waiting_confirmation', fields: CheckpointFields, activeMs: number, owner = config.instanceId): Promise<void> {
  const entries = Object.entries(fields)
  const sets = entries.map(([key], i) => `${key} = $${i + 5}`)
  const values = entries.map(([key, value]) => (JSON_FIELDS.has(key) ? JSON.stringify(value) : value))
  const { rowCount } = await pool.query(
    `UPDATE turns SET ${[...sets, 'status = $3', 'active_ms = active_ms + $4', 'waiting_since = now()', 'lease_owner = NULL', 'lease_expires_at = NULL', 'updated_at = now()'].join(', ')}
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [turnId, owner, status, activeMs, ...values],
  )
  if (!rowCount) throw new LeaseLostError(turnId)
}

export interface Finish {
  status: 'completed' | 'failed' | 'cancelled'
  finalText: string | null
  citations: unknown[]
  errorCode?: string
  errorMessage?: string
  activeMs: number
}

/** Terminal transition. `owner` null means "from a waiting state, no lease held". */
export async function finishTurn(turnId: string, finish: Finish, fields: CheckpointFields, owner: string | null = config.instanceId): Promise<boolean> {
  const entries = Object.entries(fields)
  const sets = entries.map(([key], i) => `${key} = $${i + 9}`)
  const values = entries.map(([key, value]) => (JSON_FIELDS.has(key) ? JSON.stringify(value) : value))
  const guard = owner ? `lease_owner = $2 AND status = 'running'` : `($2::text IS NULL AND status = ANY('{waiting_client,waiting_confirmation}'))`
  const { rowCount } = await pool.query(
    `UPDATE turns SET ${[
      ...sets,
      'status = $3',
      'final_text = $4',
      'citations = $5',
      'error_code = $6',
      'error_message = $7',
      'active_ms = active_ms + $8',
      'lease_owner = NULL',
      'lease_expires_at = NULL',
      'waiting_since = NULL',
      'completed_at = now()',
      'updated_at = now()',
    ].join(', ')}
      WHERE id = $1 AND ${guard}`,
    [turnId, owner, finish.status, finish.finalText, JSON.stringify(finish.citations), finish.errorCode ?? null, finish.errorMessage ?? null, finish.activeMs, ...values],
  )
  return (rowCount ?? 0) > 0
}

export interface StepRecord {
  step: number
  kind: 'model_call' | 'tool_call' | 'policy' | 'notice' | 'wrap_up' | 'prefetch' | 'compaction'
  name?: string
  detail?: Record<string, unknown>
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

export async function recordStep(turnId: string, record: StepRecord): Promise<void> {
  await pool.query(
    `INSERT INTO turn_steps (turn_id, step, kind, name, detail, latency_ms, input_tokens, output_tokens, cache_read_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      turnId,
      record.step,
      record.kind,
      record.name ?? null,
      JSON.stringify(record.detail ?? {}),
      record.latencyMs ?? null,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.cacheReadTokens ?? null,
    ],
  )
}
