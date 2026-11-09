/**
 * The state transitions that keep every decision bound to one commit.
 *
 * Everything here runs inside the caller's transaction, under the pull request's
 * row lock, so a push and a decision are strictly ordered: either the push sees
 * the decision and invalidates it, or the worker's fenced write sees the push and
 * writes nothing. A webhook, the reconciler and the poster all reach a head change
 * through syncPullRequest, so there is one code path however it was noticed.
 *
 * Lock order: pull_requests row, then audit_chains row.
 * @module shared/review-state
 */
import type { PoolClient } from 'pg'
import { appendAudit } from './audit.js'
import { approvalBody, escalationComment, shadowComment } from './comment.js'
import { config } from './config.js'
import type { DecisionResult, ModelSignal } from './gate/decide.js'
import type { GateResult } from './gate/types.js'
import type { HostPull } from './host-types.js'
import { newId } from './ids.js'
import type { ModelOutput } from './model-output.js'
import type { RepoRow } from './repos.js'
import type { DecisionRow, PrRow, RunRow } from './rows.js'

const APPROVING = ['auto_approved', 'human_approved']

export async function createRun(tx: PoolClient, repo: RepoRow, pr: PrRow, kind: 'full' | 'gate_only', trigger: string, actor: string): Promise<string | null> {
  const id = newId('run')
  const res = await tx.query(
    `INSERT INTO review_runs (id, repo_id, pr_id, pr_number, head_sha, base_ref, kind, trigger, model_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (pr_id, head_sha) WHERE status IN ('queued','running') DO NOTHING`,
    [id, repo.id, pr.id, pr.number, pr.head_sha, pr.base_ref, kind, trigger, repo.model_version],
  )
  if (res.rowCount === 0) return null
  if (kind === 'full') {
    await appendAudit(tx, { repoId: repo.id, kind: 'run_queued', actor, prNumber: pr.number, headSha: pr.head_sha, runId: id, payload: { trigger, modelVersion: repo.model_version } })
  }
  await tx.query(`SELECT pg_notify('review_run_queued', $1)`, [id])
  return id
}

/** Cancels whatever has not reached the host. Returns when an in-flight approval's lease runs out, so a dismissal can wait for it. */
async function cancelUnposted(tx: PoolClient, prId: string, reason: string, kinds: string[] = ['approve', 'comment']): Promise<Date | null> {
  const inflight = await tx.query<{ until: Date | null }>(`SELECT max(lease_expires_at) AS until FROM post_intents WHERE pr_id = $1 AND kind = 'approve' AND status = 'running' AND lease_expires_at > now()`, [prId])
  await tx.query(
    `UPDATE post_intents SET status = 'cancelled', outcome = $2, lease_token = NULL, finished_at = now()
     WHERE pr_id = $1 AND status IN ('pending','running') AND kind = ANY($3)`,
    [prId, reason, kinds],
  )
  return inflight.rows[0]?.until ?? null
}

async function queueDismissal(tx: PoolClient, repo: RepoRow, pr: PrRow, decision: DecisionRow, reason: string, notBefore: Date | null): Promise<void> {
  await tx.query(
    `INSERT INTO post_intents (id, repo_id, pr_id, pr_number, decision_id, head_sha, kind, body, actor, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,'dismiss',$7,'system',GREATEST(now(), COALESCE($8::timestamptz, now())))`,
    [newId('int'), repo.id, pr.id, pr.number, decision.id, decision.head_sha, reason, notBefore],
  )
  await tx.query(`SELECT pg_notify('post_intent_queued', $1)`, [pr.id])
}

/** Invalidates the active decision, queuing a dismissal if it was (or was about to be) an approval. */
export async function invalidateActiveDecision(tx: PoolClient, repo: RepoRow, pr: PrRow, reason: string, actor: string, notBefore: Date | null): Promise<DecisionRow | null> {
  const res = await tx.query<DecisionRow>(`UPDATE decisions SET state = 'invalidated', invalidated_reason = $2, invalidated_at = now() WHERE pr_id = $1 AND state = 'active' RETURNING *`, [pr.id, reason])
  const decision = res.rows[0]
  if (!decision) return null
  await appendAudit(tx, { repoId: repo.id, kind: 'decision_invalidated', actor, prNumber: pr.number, headSha: decision.head_sha, decisionId: decision.id, runId: decision.run_id, payload: { reason, outcome: decision.outcome } })
  if (APPROVING.includes(decision.outcome)) await queueDismissal(tx, repo, pr, decision, reason, notBefore)
  return decision
}

async function invalidateEscalations(tx: PoolClient, repo: RepoRow, pr: PrRow, reason: string, actor: string, onlyOpen = false): Promise<void> {
  const res = await tx.query<{ id: string; head_sha: string }>(
    `UPDATE escalations SET status = 'invalidated', invalidated_reason = $2 WHERE pr_id = $1 AND status = ANY($3) RETURNING id, head_sha`,
    [pr.id, reason, onlyOpen ? ['open'] : ['open', 'claimed']],
  )
  for (const e of res.rows) {
    await appendAudit(tx, { repoId: repo.id, kind: 'escalation_invalidated', actor, prNumber: pr.number, headSha: e.head_sha, payload: { escalationId: e.id, reason } })
  }
}

/** A new head or base: nothing decided about the old state survives. */
async function applyHeadChange(tx: PoolClient, repo: RepoRow, pr: PrRow, pull: HostPull, reason: 'push' | 'base_changed', actor: string): Promise<void> {
  const oldSha = pr.head_sha
  const newSha = pull.head.sha
  const superseded = await tx.query<{ id: string; status: string; head_sha: string }>(
    `UPDATE review_runs SET status = 'cancelled', cancel_reason = $2, superseded_by_sha = $3, lease_token = NULL, finished_at = now()
     WHERE pr_id = $1 AND status IN ('queued','running') RETURNING id, status, head_sha`,
    [pr.id, reason === 'push' ? 'superseded_by_push' : 'base_changed', newSha],
  )
  for (const run of superseded.rows) {
    await appendAudit(tx, { repoId: repo.id, kind: 'run_superseded', actor, prNumber: pr.number, headSha: run.head_sha, runId: run.id, payload: { newSha, reason } })
    await tx.query(`SELECT pg_notify('review_run_cancel', $1)`, [run.id])
  }
  const notBefore = await cancelUnposted(tx, pr.id, reason === 'push' ? 'superseded_by_push' : 'base_changed')
  await invalidateActiveDecision(tx, repo, pr, reason === 'push' ? `Push to ${newSha.slice(0, 7)}` : `Base changed to ${pull.base.ref}`, actor, notBefore)
  await invalidateEscalations(tx, repo, pr, reason === 'push' ? 'superseded_by_push' : 'base_changed', actor)
  const updated = await tx.query<PrRow>(`UPDATE pull_requests SET head_sha = $2, head_seq = $3, base_ref = $4, title = $5, updated_at = now() WHERE id = $1 RETURNING *`, [pr.id, newSha, pull.head_seq, pull.base.ref, pull.title])
  await appendAudit(tx, { repoId: repo.id, kind: 'head_changed', actor, prNumber: pr.number, headSha: newSha, payload: { reason, oldSha, newSha, baseRef: pull.base.ref, supersededRuns: superseded.rows.map((r) => r.id) } })
  await createRun(tx, repo, updated.rows[0], 'full', reason, actor)
}

async function applyClosed(tx: PoolClient, repo: RepoRow, pr: PrRow, pull: HostPull, actor: string): Promise<void> {
  const runs = await tx.query<{ id: string }>(`UPDATE review_runs SET status = 'cancelled', cancel_reason = 'pr_closed', lease_token = NULL, finished_at = now() WHERE pr_id = $1 AND status IN ('queued','running') RETURNING id`, [pr.id])
  for (const r of runs.rows) await tx.query(`SELECT pg_notify('review_run_cancel', $1)`, [r.id])
  await cancelUnposted(tx, pr.id, 'pr_closed')
  await invalidateEscalations(tx, repo, pr, 'pr_closed', actor)
  await tx.query(`UPDATE pull_requests SET state = $2, updated_at = now() WHERE id = $1`, [pr.id, pull.state])
}

export type SyncOutcome = 'created' | 'head_changed' | 'base_changed' | 'closed' | 'reopened' | 'unchanged' | 'stale'

/**
 * Brings the local pull request in line with the host. An older `head_seq` is an
 * out-of-order delivery and changes nothing, so this is safe to call from anywhere,
 * any number of times.
 */
export async function syncPullRequest(tx: PoolClient, repo: RepoRow, pull: HostPull, actor: string): Promise<SyncOutcome> {
  const inserted = await tx.query<PrRow>(
    `INSERT INTO pull_requests (id, repo_id, number, title, author, base_ref, head_sha, head_seq, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (repo_id, number) DO NOTHING RETURNING *`,
    [newId('pr'), repo.id, pull.number, pull.title, pull.user.login, pull.base.ref, pull.head.sha, pull.head_seq, pull.state],
  )
  if (inserted.rows[0]) {
    if (pull.state === 'open') await createRun(tx, repo, inserted.rows[0], 'full', 'opened', actor)
    return 'created'
  }
  const locked = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2 FOR UPDATE`, [repo.id, pull.number])
  const pr = locked.rows[0]
  if (pull.head_seq < pr.head_seq) return 'stale'
  if (pull.state !== 'open') {
    if (pr.state === pull.state) return 'unchanged'
    await applyClosed(tx, repo, pr, pull, actor)
    return 'closed'
  }
  if (pull.head.sha !== pr.head_sha) {
    await applyHeadChange(tx, repo, pr, pull, 'push', actor)
    return 'head_changed'
  }
  if (pull.base.ref !== pr.base_ref) {
    await applyHeadChange(tx, repo, pr, pull, 'base_changed', actor)
    return 'base_changed'
  }
  if (pull.title !== pr.title) await tx.query(`UPDATE pull_requests SET title = $2, updated_at = now() WHERE id = $1`, [pr.id, pull.title])
  return 'unchanged'
}

/**
 * Facts changed at the same head: CI reported, or a person reviewed. Re-apply the
 * gate without calling the model again. Skips what a person has already claimed
 * or decided, and whatever already has a run in flight (the full run reads fresh
 * facts after the model returns, and the sweeper catches the remaining window).
 */
export async function requestReevaluation(tx: PoolClient, repo: RepoRow, pr: PrRow, trigger: string, actor: string): Promise<boolean> {
  const active = await tx.query<DecisionRow>(`SELECT * FROM decisions WHERE pr_id = $1 AND state = 'active'`, [pr.id])
  const d = active.rows[0]
  if (!d || d.head_sha !== pr.head_sha) return false
  if (d.outcome === 'human_approved' || d.outcome === 'human_rejected') return false
  if (d.outcome === 'escalated') {
    if (!['gate_failed', 'missing_data', 'ci_missing'].includes(d.reason_code)) return false
    const open = await tx.query(`SELECT 1 FROM escalations WHERE pr_id = $1 AND head_sha = $2 AND status = 'claimed'`, [pr.id, pr.head_sha])
    if (open.rowCount) return false
  }
  return (await createRun(tx, repo, pr, 'gate_only', trigger, actor)) !== null
}

export interface RecordDecisionArgs {
  repo: RepoRow
  pr: PrRow
  runId: string | null
  headSha: string
  result: DecisionResult
  gate: GateResult
  modelVersion: string | null
  modelOutput: ModelOutput | null
  actor: string
}

/**
 * Writes a gate decision and everything that follows from it. A post intent is
 * only ever created here (or by a human decision), which is why nothing else in
 * the system can cause an approval.
 */
export async function recordDecision(tx: PoolClient, a: RecordDecisionArgs): Promise<DecisionRow> {
  const { repo, pr, result, gate, headSha, actor } = a
  const prior = await tx.query<DecisionRow>(`SELECT * FROM decisions WHERE pr_id = $1 AND state = 'active'`, [pr.id])
  const before = prior.rows[0]
  const notBefore = result.outcome === 'auto_approved' ? null : await cancelUnposted(tx, pr.id, 'superseded_by_new_decision')
  if (before) await invalidateActiveDecision(tx, repo, pr, `Re-evaluated: ${result.reasonCode}`, actor, notBefore)
  if (result.outcome !== 'escalated') await invalidateEscalations(tx, repo, pr, 're-evaluated', actor, true)

  const inserted = await tx.query<DecisionRow>(
    `INSERT INTO decisions (id, repo_id, pr_id, pr_number, run_id, head_sha, mode, outcome, would, reason_code, reason, model_overruled, policy_version, settings_version, category, gate, model_version, actor, waiting_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, CASE WHEN $8 = 'waiting_ci' THEN COALESCE($19::timestamptz, now()) END)
     RETURNING *`,
    [
      newId('dec'),
      repo.id,
      pr.id,
      pr.number,
      a.runId,
      headSha,
      repo.mode,
      result.outcome,
      result.would,
      result.reasonCode,
      result.reason,
      result.modelOverruled,
      gate.policyVersion,
      repo.settings_version,
      gate.category,
      JSON.stringify(gate),
      a.modelVersion,
      actor,
      before?.outcome === 'waiting_ci' && before.head_sha === headSha ? before.waiting_since : null,
    ],
  )
  const decision = inserted.rows[0]
  await appendAudit(tx, {
    repoId: repo.id,
    kind: 'decision',
    actor,
    prNumber: pr.number,
    headSha,
    runId: a.runId,
    decisionId: decision.id,
    payload: {
      mode: repo.mode,
      outcome: result.outcome,
      would: result.would,
      reasonCode: result.reasonCode,
      reason: result.reason,
      modelOverruled: result.modelOverruled,
      policyVersion: gate.policyVersion,
      settingsVersion: repo.settings_version,
      category: gate.category,
      failedRules: gate.failed,
      unknownRules: gate.unknown,
    },
  })

  if (result.outcome === 'auto_approved') {
    await createIntent(tx, repo, pr, decision.id, headSha, 'approve', approvalBody(headSha, gate), actor)
  } else if (result.outcome === 'shadow') {
    await createIntent(tx, repo, pr, decision.id, headSha, 'comment', shadowComment(headSha, result, a.modelOutput), actor)
  } else if (result.outcome === 'escalated') {
    const opened = await tx.query<{ id: string }>(
      `INSERT INTO escalations (id, repo_id, pr_id, pr_number, decision_id, head_sha, reason_code, reason, model_overruled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (pr_id, head_sha) WHERE status IN ('open','claimed') DO UPDATE SET decision_id = EXCLUDED.decision_id, reason_code = EXCLUDED.reason_code, reason = EXCLUDED.reason, model_overruled = EXCLUDED.model_overruled
       RETURNING id`,
      [newId('esc'), repo.id, pr.id, pr.number, decision.id, headSha, result.reasonCode, result.reason, result.modelOverruled],
    )
    await appendAudit(tx, { repoId: repo.id, kind: 'escalation_opened', actor, prNumber: pr.number, headSha, decisionId: decision.id, payload: { escalationId: opened.rows[0].id, reasonCode: result.reasonCode, reason: result.reason, modelOverruled: result.modelOverruled } })
    await createIntent(tx, repo, pr, decision.id, headSha, 'comment', escalationComment(headSha, result, a.modelOutput), actor)
  }
  return decision
}

export async function createIntent(tx: PoolClient, repo: RepoRow, pr: PrRow, decisionId: string | null, headSha: string, kind: 'approve' | 'comment', body: string, actor: string): Promise<string> {
  const id = newId('int')
  await tx.query(`INSERT INTO post_intents (id, repo_id, pr_id, pr_number, decision_id, head_sha, kind, body, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, repo.id, pr.id, pr.number, decisionId, headSha, kind, body, actor])
  await tx.query(`SELECT pg_notify('post_intent_queued', $1)`, [id])
  return id
}

/** The model's contribution as stored on a run. */
export function signalOf(run: Pick<RunRow, 'model_outcome' | 'parsed_output' | 'error_detail'>): ModelSignal {
  if (run.parsed_output && run.model_outcome === 'assessment') {
    return { kind: 'assessment', verdict: run.parsed_output.verdict, risk: run.parsed_output.risk, confidence: run.parsed_output.confidence }
  }
  const code = run.model_outcome === 'model_timeout' || run.model_outcome === 'model_malformed' || run.model_outcome === 'model_not_called' ? run.model_outcome : 'model_unavailable'
  return { kind: 'failure', code, detail: run.error_detail ?? 'The model did not produce an assessment' }
}

export const isBot = (repo: RepoRow, login: string) => repo.bot_logins.includes(login) || login === config.botLogin
