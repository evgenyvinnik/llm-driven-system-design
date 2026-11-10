/**
 * Read models for the console. Handlers never return database rows: everything is
 * mapped to a camelCase DTO here.
 * @module api/services/views
 */
import type { SessionUser } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import type { DecisionRow, EscalationRow, IntentRow, RunRow } from '../../shared/rows.js'

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

export function orgFilter(user: SessionUser, column = 'r.org_id', index = 1): { sql: string; params: unknown[] } {
  if (user.role === 'admin') return { sql: 'TRUE', params: [] }
  return { sql: `${column} = $${index}`, params: [user.orgId] }
}

export function decisionDto(d: DecisionRow) {
  return {
    id: d.id,
    runId: d.run_id,
    headSha: d.head_sha,
    mode: d.mode,
    outcome: d.outcome,
    would: d.would,
    reasonCode: d.reason_code,
    reason: d.reason,
    modelOverruled: d.model_overruled,
    policyVersion: d.policy_version,
    settingsVersion: d.settings_version,
    category: d.category,
    gate: d.gate,
    modelVersion: d.model_version,
    actor: d.actor,
    state: d.state,
    invalidatedReason: d.invalidated_reason,
    invalidatedAt: iso(d.invalidated_at),
    postedReviewId: d.posted_review_id,
    postedAt: iso(d.posted_at),
    dismissedAt: iso(d.dismissed_at),
    humanOutcome: d.human_outcome,
    falseApprovalReportedAt: iso(d.false_approval_reported_at),
    falseApprovalReportedBy: d.false_approval_reported_by,
    createdAt: iso(d.created_at),
  }
}

export function runDto(r: RunRow) {
  return {
    id: r.id,
    headSha: r.head_sha,
    baseRef: r.base_ref,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    attempt: r.attempt,
    cancelReason: r.cancel_reason,
    supersededBySha: r.superseded_by_sha,
    modelVersion: r.model_version,
    modelOutcome: r.model_outcome,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    diffHash: r.diff_hash,
    promptHash: r.prompt_hash,
    rawOutput: r.raw_output,
    parsedOutput: r.parsed_output,
    toolCalls: r.tool_calls,
    scannerHits: r.scanner_hits,
    files: r.files_snapshot,
    usage: { inputTokens: r.input_tokens, outputTokens: r.output_tokens, queueMs: r.queue_ms, ttftMs: r.ttft_ms, generationMs: r.generation_ms, modelCalls: r.model_calls },
    createdAt: iso(r.created_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  }
}

export function intentDto(i: IntentRow) {
  return { id: i.id, kind: i.kind, headSha: i.head_sha, status: i.status, outcome: i.outcome, attempts: i.attempts, actor: i.actor, reviewIds: i.review_ids, error: i.error, createdAt: iso(i.created_at), finishedAt: iso(i.finished_at) }
}

export function escalationDto(e: EscalationRow) {
  return {
    id: e.id,
    prNumber: e.pr_number,
    headSha: e.head_sha,
    reasonCode: e.reason_code,
    reason: e.reason,
    modelOverruled: e.model_overruled,
    status: e.status,
    claimedBy: e.claimed_by,
    claimedAt: iso(e.claimed_at),
    decidedBy: e.decided_by,
    decidedAt: iso(e.decided_at),
    resolution: e.resolution,
    note: e.note,
    invalidatedReason: e.invalidated_reason,
    createdAt: iso(e.created_at),
  }
}

export interface AuditRow {
  repo_id: string
  full_name: string
  seq: number
  prev_hash: string
  hash: string
  kind: string
  actor: string
  pr_number: number | null
  head_sha: string | null
  run_id: string | null
  decision_id: string | null
  payload: unknown
  created_at: Date
}

export function auditDto(a: AuditRow) {
  return {
    repoId: a.repo_id,
    repo: a.full_name,
    seq: Number(a.seq),
    prevHash: a.prev_hash,
    hash: a.hash,
    kind: a.kind,
    actor: a.actor,
    prNumber: a.pr_number,
    headSha: a.head_sha,
    runId: a.run_id,
    decisionId: a.decision_id,
    payload: a.payload,
    createdAt: iso(a.created_at),
  }
}

export interface PrListFilters {
  repo?: string
  outcome?: string
  overruled?: boolean
  limit: number
}

export async function listPullRequests(user: SessionUser, f: PrListFilters) {
  const scope = orgFilter(user)
  const params: unknown[] = [...scope.params]
  const where = [scope.sql]
  if (f.repo) {
    params.push(f.repo)
    where.push(`r.full_name = $${params.length}`)
  }
  if (f.outcome) {
    params.push(f.outcome)
    where.push(`d.outcome = $${params.length}`)
  }
  if (f.overruled) where.push(`d.model_overruled`)
  params.push(f.limit)
  const res = await pool.query(
    `SELECT p.number, p.title, p.author, p.base_ref, p.head_sha, p.state, p.updated_at, r.id AS repo_id, r.full_name, r.mode, r.kill_switch,
            d.id AS decision_id, d.outcome, d.would, d.reason_code, d.reason, d.model_overruled, d.state AS decision_state, d.head_sha AS decision_sha, d.posted_review_id, d.dismissed_at, d.invalidated_reason,
            run.status AS run_status, run.head_sha AS run_sha, run.model_outcome, run.parsed_output->>'verdict' AS model_verdict, (run.parsed_output->>'confidence')::float AS model_confidence
     FROM pull_requests p
     JOIN repositories r ON r.id = p.repo_id
     LEFT JOIN LATERAL (SELECT * FROM decisions x WHERE x.pr_id = p.id ORDER BY x.created_at DESC LIMIT 1) d ON TRUE
     LEFT JOIN LATERAL (SELECT status, head_sha, model_outcome, parsed_output FROM review_runs y WHERE y.pr_id = p.id AND y.kind = 'full' ORDER BY y.created_at DESC LIMIT 1) run ON TRUE
     WHERE ${where.join(' AND ')}
     ORDER BY p.updated_at DESC, p.number DESC
     LIMIT $${params.length}`,
    params,
  )
  return res.rows.map((x) => ({
    repo: { id: x.repo_id, fullName: x.full_name, mode: x.mode, killSwitch: x.kill_switch },
    number: x.number,
    title: x.title,
    author: x.author,
    baseRef: x.base_ref,
    headSha: x.head_sha,
    state: x.state,
    updatedAt: iso(x.updated_at),
    run: x.run_status ? { status: x.run_status, headSha: x.run_sha, modelOutcome: x.model_outcome, modelVerdict: x.model_verdict, modelConfidence: x.model_confidence } : null,
    decision: x.decision_id
      ? {
          id: x.decision_id,
          outcome: x.outcome,
          would: x.would,
          reasonCode: x.reason_code,
          reason: x.reason,
          modelOverruled: x.model_overruled,
          state: x.decision_state,
          headSha: x.decision_sha,
          postedReviewId: x.posted_review_id,
          dismissedAt: iso(x.dismissed_at),
          invalidatedReason: x.invalidated_reason,
        }
      : null,
  }))
}

export async function listEscalations(user: SessionUser, f: { status?: string; repo?: string }) {
  const scope = orgFilter(user)
  const params: unknown[] = [...scope.params]
  const where = [scope.sql]
  if (f.status && f.status !== 'all') {
    params.push(f.status === 'active' ? ['open', 'claimed'] : [f.status])
    where.push(`e.status = ANY($${params.length})`)
  }
  if (f.repo) {
    params.push(f.repo)
    where.push(`r.full_name = $${params.length}`)
  }
  const res = await pool.query(
    `SELECT e.*, r.full_name, r.mode, p.title, p.author, p.head_sha AS current_head
     FROM escalations e JOIN repositories r ON r.id = e.repo_id JOIN pull_requests p ON p.id = e.pr_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END, e.created_at DESC
     LIMIT 200`,
    params,
  )
  return res.rows.map((x) => ({ ...escalationDto(x as EscalationRow), repo: x.full_name, mode: x.mode, title: x.title, author: x.author, currentHead: x.current_head }))
}
