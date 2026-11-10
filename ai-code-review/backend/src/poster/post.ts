/**
 * The poster: a separate process with its own credential, and the only thing that
 * writes to the host. It acts on durable intents, which only a gate decision or a
 * human decision can create.
 *
 * Before an approval it runs the gate again on fresh facts. That closes most of the
 * window between deciding and acting. The `commit_id` on the post closes the rest:
 * the host refuses it if that commit is no longer the head.
 *
 * A crash after the host accepted a review is safe: the retry carries the same
 * idempotency key and gets the same review back.
 * @module poster/post
 */
import { appendAudit } from '../shared/audit.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { toGateFacts } from '../shared/facts.js'
import { decide, type DecisionResult } from '../shared/gate/decide.js'
import { evaluateGate } from '../shared/gate/rules.js'
import type { HostPull, HostReader, HostWriter, PullSnapshot } from '../shared/host-types.js'
import { newLeaseToken } from '../shared/ids.js'
import { logger } from '../shared/logger.js'
import { postsFinished } from '../shared/metrics.js'
import { loadRepo, policyOf, type RepoRow } from '../shared/repos.js'
import { recordDecision, signalOf, syncPullRequest } from '../shared/review-state.js'
import type { DecisionRow, IntentRow, PrRow, RunRow } from '../shared/rows.js'

export interface PosterDeps {
  reader: HostReader
  writer: HostWriter
  actor?: string
}

export async function claimNextIntent(instanceId: string): Promise<IntentRow | null> {
  const res = await pool.query<IntentRow>(
    `WITH next AS (
       SELECT id FROM post_intents i
       WHERE ((status = 'pending' AND next_attempt_at <= now()) OR (status = 'running' AND lease_expires_at < now()))
         -- First in, first out per pull request: a dismissal must finish before a later approval starts.
         AND NOT EXISTS (
           SELECT 1 FROM post_intents e
           WHERE e.pr_id = i.pr_id AND e.status IN ('pending','running') AND (e.created_at, e.id) < (i.created_at, i.id)
         )
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE post_intents i
     SET status = 'running', attempts = i.attempts + 1, claimed_by = $1, lease_token = $2,
         lease_expires_at = now() + ($3 || ' milliseconds')::interval
     FROM next WHERE i.id = next.id RETURNING i.*`,
    [instanceId, newLeaseToken(), String(config.poster.leaseMs)],
  )
  return res.rows[0] ?? null
}

/** Fenced: a cancelled intent's owner learns here that it no longer owns it. */
async function finish(tx: Pick<typeof pool, 'query'>, intent: IntentRow, status: 'done' | 'cancelled' | 'failed', outcome: string, reviewIds: number[] = [], error: string | null = null): Promise<boolean> {
  const res = await tx.query(
    `UPDATE post_intents SET status = $3, outcome = $4, review_ids = $5, error = $6, lease_token = NULL, finished_at = now() WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [intent.id, intent.lease_token, status, outcome, JSON.stringify(reviewIds), error],
  )
  postsFinished.inc({ kind: intent.kind, result: outcome })
  return (res.rowCount ?? 0) > 0
}

async function retryLater(intent: IntentRow, err: Error): Promise<void> {
  const delay = Math.min(config.poster.retryBaseMs * 2 ** intent.attempts, 8000)
  await pool.query(`UPDATE post_intents SET status = 'pending', lease_token = NULL, next_attempt_at = now() + ($3 || ' milliseconds')::interval, error = $4 WHERE id = $1 AND lease_token = $2`, [intent.id, intent.lease_token, String(delay), err.message])
}

async function syncFromHost(repo: RepoRow, pull: HostPull, actor: string): Promise<void> {
  await withTransaction((tx) => syncPullRequest(tx, repo, pull, actor))
}

async function recheck(repo: RepoRow, decision: DecisionRow, snapshot: PullSnapshot): Promise<{ result: DecisionResult; gate: ReturnType<typeof evaluateGate>; run: RunRow | null }> {
  const runRes = await pool.query<RunRow>(`SELECT * FROM review_runs WHERE pr_id = $1 AND head_sha = $2 AND kind = 'full' AND status IN ('completed','failed') ORDER BY created_at DESC LIMIT 1`, [decision.pr_id, decision.head_sha])
  const run = runRes.rows[0] ?? null
  const baseRef = run?.base_ref ?? snapshot.pull.base.ref
  const gate = evaluateGate(toGateFacts(snapshot, decision.head_sha, baseRef), policyOf(repo))
  const tools = (run?.tool_calls ?? []) as { allowed: boolean }[]
  const result = decide({
    mode: repo.mode,
    killSwitch: repo.kill_switch,
    gate,
    model: run ? signalOf(run) : { kind: 'failure', code: 'model_unavailable', detail: 'No model assessment on record for this commit' },
    signals: { injection: (run?.scanner_hits ?? []).length > 0, toolDenied: tools.some((t) => !t.allowed) },
    minConfidence: config.decision.minConfidence,
  })
  return { result, gate, run }
}

async function processApprove(deps: PosterDeps, intent: IntentRow, repo: RepoRow, actor: string): Promise<void> {
  const loaded = await pool.query<DecisionRow>(`SELECT * FROM decisions WHERE id = $1`, [intent.decision_id])
  const decision = loaded.rows[0]
  if (!decision || decision.state !== 'active') {
    await finish(pool, intent, 'cancelled', 'decision_invalidated')
    return
  }
  const snapshot = await deps.reader.getSnapshot(repo.full_name, intent.pr_number)
  if (snapshot.pull.head.sha !== intent.head_sha) {
    await withTransaction(async (tx) => {
      await finish(tx, intent, 'cancelled', 'head_moved')
      await appendAudit(tx, { repoId: repo.id, kind: 'post_cancelled', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: decision.id, payload: { reason: 'head_moved', currentHead: snapshot.pull.head.sha } })
    })
    await syncFromHost(repo, snapshot.pull, actor)
    return
  }

  if (decision.outcome === 'auto_approved') {
    const { result, gate, run } = await recheck(repo, decision, snapshot)
    await withTransaction((tx) =>
      appendAudit(tx, { repoId: repo.id, kind: 'gate_rechecked', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: decision.id, payload: { outcome: result.outcome, reasonCode: result.reasonCode, passed: gate.passed, rules: gate.rules, killSwitch: repo.kill_switch, mode: repo.mode } }),
    )
    if (result.outcome !== 'auto_approved') {
      await withTransaction(async (tx) => {
        const locked = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE id = $1 FOR UPDATE`, [intent.pr_id])
        if (!(await finish(tx, intent, 'cancelled', 'recheck_failed'))) return
        if (locked.rows[0].head_sha === intent.head_sha) {
          await recordDecision(tx, { repo, pr: locked.rows[0], runId: decision.run_id, headSha: intent.head_sha, result, gate, modelVersion: decision.model_version, modelOutput: run?.parsed_output ?? null, actor })
        }
      })
      return
    }
  } else if (snapshot.pull.user.login === decision.actor) {
    await withTransaction(async (tx) => {
      await finish(tx, intent, 'cancelled', 'self_review')
    })
    return
  }

  const posted = await deps.writer.postReview(repo.full_name, intent.pr_number, { commitId: intent.head_sha, event: 'APPROVE', body: intent.body, idempotencyKey: intent.id })
  if (!posted.ok) {
    if (posted.code === 'STALE_COMMIT') {
      await withTransaction(async (tx) => {
        await finish(tx, intent, 'cancelled', 'stale_rejected')
        await appendAudit(tx, { repoId: repo.id, kind: 'post_rejected_stale', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: decision.id, payload: { attemptedSha: intent.head_sha, currentHead: posted.currentHead } })
      })
      await syncFromHost(repo, await deps.reader.getPull(repo.full_name, intent.pr_number), actor)
      return
    }
    await finish(pool, intent, 'cancelled', posted.code.toLowerCase())
    return
  }

  const owned = await withTransaction(async (tx) => {
    if (!(await finish(tx, intent, 'done', 'posted', [posted.review.id]))) return false
    await tx.query(`UPDATE decisions SET posted_review_id = $2, posted_at = now() WHERE id = $1`, [decision.id, posted.review.id])
    await appendAudit(tx, { repoId: repo.id, kind: 'approval_posted', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: decision.id, payload: { reviewId: posted.review.id, commitId: posted.review.commit_id, replayed: posted.review.replayed, approver: decision.actor } })
    return true
  })
  if (!owned) {
    // The decision was withdrawn while this post was in flight, and the host accepted it anyway. Take it back.
    await deps.writer.dismissReview(repo.full_name, intent.pr_number, posted.review.id, 'The decision behind this approval was withdrawn')
    await withTransaction((tx) => appendAudit(tx, { repoId: repo.id, kind: 'approval_dismissed', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: decision.id, payload: { reviewIds: [posted.review.id], reason: 'withdrawn_while_posting' } }))
  }
}

async function processComment(deps: PosterDeps, intent: IntentRow, repo: RepoRow, actor: string): Promise<void> {
  const posted = await deps.writer.postReview(repo.full_name, intent.pr_number, { commitId: intent.head_sha, event: 'COMMENT', body: intent.body, idempotencyKey: intent.id })
  if (!posted.ok) {
    await finish(pool, intent, 'cancelled', posted.code === 'STALE_COMMIT' ? 'stale_rejected' : posted.code.toLowerCase())
    return
  }
  await withTransaction(async (tx) => {
    if (!(await finish(tx, intent, 'done', 'posted', [posted.review.id]))) return
    await appendAudit(tx, { repoId: repo.id, kind: 'comment_posted', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: intent.decision_id, payload: { reviewId: posted.review.id, body: intent.body } })
  })
}

/** Finds approvals by listing them, so one whose post never got recorded (a crash) is still found. */
async function processDismiss(deps: PosterDeps, intent: IntentRow, repo: RepoRow, actor: string): Promise<void> {
  const reviews = await deps.reader.listReviews(repo.full_name, intent.pr_number)
  const targets = reviews.filter((r) => r.user.login === config.botLogin && r.state === 'APPROVED' && !r.dismissed && r.commit_id === intent.head_sha)
  for (const r of targets) await deps.writer.dismissReview(repo.full_name, intent.pr_number, r.id, intent.body || 'This approval no longer applies')
  await withTransaction(async (tx) => {
    if (!(await finish(tx, intent, 'done', targets.length > 0 ? 'dismissed' : 'nothing_to_dismiss', targets.map((r) => r.id)))) return
    if (targets.length > 0) {
      if (intent.decision_id) await tx.query(`UPDATE decisions SET dismissed_at = now() WHERE id = $1`, [intent.decision_id])
      await appendAudit(tx, { repoId: repo.id, kind: 'approval_dismissed', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: intent.decision_id, payload: { reviewIds: targets.map((r) => r.id), reason: intent.body } })
    }
  })
}

export async function processIntent(deps: PosterDeps, intent: IntentRow): Promise<void> {
  const actor = deps.actor ?? 'poster'
  const repo = await loadRepo(pool, intent.repo_id)
  if (!repo) {
    await finish(pool, intent, 'cancelled', 'repo_missing')
    return
  }
  try {
    if (intent.kind === 'approve') await processApprove(deps, intent, repo, actor)
    else if (intent.kind === 'comment') await processComment(deps, intent, repo, actor)
    else await processDismiss(deps, intent, repo, actor)
  } catch (err) {
    logger.warn({ intent: intent.id, kind: intent.kind, attempts: intent.attempts, err: (err as Error).message }, 'post failed')
    if (intent.attempts < config.poster.maxAttempts) {
      await retryLater(intent, err as Error)
      return
    }
    await failIntent(intent, repo, actor, err as Error)
  }
}

/** An approval that can't be posted goes to a person rather than disappearing. */
async function failIntent(intent: IntentRow, repo: RepoRow, actor: string, err: Error): Promise<void> {
  await withTransaction(async (tx) => {
    if (!(await finish(tx, intent, 'failed', 'failed', [], err.message))) return
    await appendAudit(tx, { repoId: repo.id, kind: 'post_failed', actor, prNumber: intent.pr_number, headSha: intent.head_sha, decisionId: intent.decision_id, payload: { kind: intent.kind, error: err.message, attempts: intent.attempts } })
    if (intent.kind !== 'approve' || !intent.decision_id) return
    const locked = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE id = $1 FOR UPDATE`, [intent.pr_id])
    const loaded = await tx.query<DecisionRow>(`SELECT * FROM decisions WHERE id = $1`, [intent.decision_id])
    const d = loaded.rows[0]
    if (!d?.gate || locked.rows[0].head_sha !== intent.head_sha || d.state !== 'active') return
    const result: DecisionResult = { would: 'escalate', outcome: 'escalated', reasonCode: 'post_failed', reason: `The approval could not be posted after ${intent.attempts} attempts: ${err.message}`, modelOverruled: false }
    await recordDecision(tx, { repo, pr: locked.rows[0], runId: d.run_id, headSha: intent.head_sha, result, gate: d.gate, modelVersion: d.model_version, modelOutput: null, actor })
  })
}
