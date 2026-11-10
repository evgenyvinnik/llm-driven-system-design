/**
 * Append-only, hash-chained audit log. Each repository has its own chain, so a
 * tenant's log can be verified alone and contention stays per repository.
 *
 * An entry's hash covers its content and the previous hash, so changing or
 * deleting any row breaks every later link. `audit_chains` is the anchor: it
 * records the last sequence number and hash, which also catches a truncated
 * tail. A trigger refuses UPDATE and DELETE. In production the app role would
 * have INSERT and SELECT only, and the anchor would be published to write-once
 * storage, because a chain alone is tamper-evident rather than tamper-proof.
 *
 * Lock order is always pull_requests row, then audit_chains row.
 * @module shared/audit
 */
import { createHash } from 'node:crypto'
import type { Queryable } from './db.js'

export const GENESIS_HASH = '0'.repeat(64)
const TS_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`

export type AuditKind =
  | 'head_changed'
  | 'run_queued'
  | 'run_started'
  | 'run_superseded'
  | 'run_lease_lost'
  | 'run_failed'
  | 'ci_reported'
  | 'tool_requested'
  | 'tool_denied'
  | 'model_output'
  | 'gate_evaluated'
  | 'decision'
  | 'decision_invalidated'
  | 'gate_rechecked'
  | 'approval_posted'
  | 'comment_posted'
  | 'post_rejected_stale'
  | 'post_cancelled'
  | 'post_failed'
  | 'approval_dismissed'
  | 'escalation_opened'
  | 'escalation_claimed'
  | 'escalation_released'
  | 'escalation_decided'
  | 'escalation_invalidated'
  | 'human_review_observed'
  | 'settings_changed'
  | 'mode_promoted'
  | 'promotion_refused'
  | 'mode_demoted'
  | 'kill_switch_changed'
  | 'false_approval_reported'

export interface AuditInput {
  repoId: string
  kind: AuditKind
  actor: string
  prNumber?: number | null
  headSha?: string | null
  runId?: string | null
  decisionId?: string | null
  payload?: Record<string, unknown>
}

export interface AuditContent {
  repoId: string
  seq: number
  prevHash: string
  kind: string
  actor: string
  prNumber: number | null
  headSha: string | null
  runId: string | null
  decisionId: string | null
  payload: unknown
  createdAt: string
}

/** Sorted keys at every depth, so the hash is independent of how JSONB reorders objects. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

export function entryHash(entry: AuditContent): string {
  return createHash('sha256').update(canonicalize(entry)).digest('hex')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** PostgreSQL text and JSONB cannot hold NUL. Hostile model output must not be able to break the audit write. */
export function sanitizeForStorage<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\u0000/g, '�') as unknown as T
  if (Array.isArray(value)) return value.map(sanitizeForStorage) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[sanitizeForStorage(k)] = sanitizeForStorage(v)
    return out as T
  }
  return value
}

/** Must run inside the caller's transaction, so the record and the action commit together. */
export async function appendAudit(tx: Queryable, input: AuditInput): Promise<{ seq: number; hash: string }> {
  await tx.query(`INSERT INTO audit_chains (repo_id) VALUES ($1) ON CONFLICT (repo_id) DO NOTHING`, [input.repoId])
  const chain = await tx.query<{ last_seq: number; last_hash: string; ts: string }>(
    `SELECT last_seq, last_hash, to_char(clock_timestamp() AT TIME ZONE 'UTC', '${TS_FORMAT}') AS ts
     FROM audit_chains WHERE repo_id = $1 FOR UPDATE`,
    [input.repoId],
  )
  const { last_seq, last_hash, ts } = chain.rows[0]
  const payload = sanitizeForStorage(input.payload ?? {})
  const content: AuditContent = {
    repoId: input.repoId,
    seq: Number(last_seq) + 1,
    prevHash: last_hash,
    kind: input.kind,
    actor: input.actor,
    prNumber: input.prNumber ?? null,
    headSha: input.headSha ?? null,
    runId: input.runId ?? null,
    decisionId: input.decisionId ?? null,
    payload,
    createdAt: ts,
  }
  const hash = entryHash(content)
  await tx.query(
    `INSERT INTO audit_log (repo_id, seq, prev_hash, hash, kind, actor, pr_number, head_sha, run_id, decision_id, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
    [input.repoId, content.seq, content.prevHash, hash, content.kind, content.actor, content.prNumber, content.headSha, content.runId, content.decisionId, JSON.stringify(payload), ts],
  )
  await tx.query(`UPDATE audit_chains SET last_seq = $2, last_hash = $3 WHERE repo_id = $1`, [input.repoId, content.seq, hash])
  return { seq: content.seq, hash }
}

export interface ChainProblem {
  seq: number
  problem: 'hash_mismatch' | 'broken_link' | 'gap' | 'anchor_mismatch'
  detail: string
}

export interface ChainRow extends AuditContent {
  hash: string
}

/** Pure walk over a chain, ascending by seq. */
export function verifyRows(repoId: string, rows: ChainRow[], anchor: { lastSeq: number; lastHash: string } | null): { ok: boolean; checked: number; problems: ChainProblem[] } {
  const problems: ChainProblem[] = []
  let expectedPrev = GENESIS_HASH
  let expectedSeq = 1
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      problems.push({ seq: row.seq, problem: 'gap', detail: `Expected sequence ${expectedSeq}, found ${row.seq}: entries are missing` })
      expectedSeq = row.seq
    }
    if (row.prevHash !== expectedPrev) {
      problems.push({ seq: row.seq, problem: 'broken_link', detail: `Previous hash does not match entry ${row.seq - 1}` })
    }
    const { hash, ...content } = row
    if (entryHash({ ...content, repoId }) !== hash) {
      problems.push({ seq: row.seq, problem: 'hash_mismatch', detail: `Entry ${row.seq} (${row.kind}) does not match its hash: its content was changed` })
    }
    expectedPrev = row.hash
    expectedSeq++
  }
  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0
  if (anchor && (anchor.lastSeq !== lastSeq || (rows.length > 0 && anchor.lastHash !== expectedPrev))) {
    problems.push({ seq: anchor.lastSeq, problem: 'anchor_mismatch', detail: `The anchor expects sequence ${anchor.lastSeq}, the log ends at ${lastSeq}` })
  }
  return { ok: problems.length === 0, checked: rows.length, problems }
}

export async function verifyChain(db: Queryable, repoId: string) {
  const res = await db.query(
    `SELECT seq, prev_hash, hash, kind, actor, pr_number, head_sha, run_id, decision_id, payload,
            to_char(created_at AT TIME ZONE 'UTC', '${TS_FORMAT}') AS ts
     FROM audit_log WHERE repo_id = $1 ORDER BY seq`,
    [repoId],
  )
  const rows: ChainRow[] = res.rows.map((r) => ({
    repoId,
    seq: Number(r.seq),
    prevHash: r.prev_hash,
    hash: r.hash,
    kind: r.kind,
    actor: r.actor,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    runId: r.run_id,
    decisionId: r.decision_id,
    payload: r.payload,
    createdAt: r.ts,
  }))
  const anchor = await db.query<{ last_seq: number; last_hash: string }>(`SELECT last_seq, last_hash FROM audit_chains WHERE repo_id = $1`, [repoId])
  const a = anchor.rows[0]
  return verifyRows(repoId, rows, a ? { lastSeq: Number(a.last_seq), lastHash: a.last_hash } : null)
}
