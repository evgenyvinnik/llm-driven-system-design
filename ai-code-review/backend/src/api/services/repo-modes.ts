/**
 * Repository modes and everything that changes what a repository is allowed to do:
 * promotion (requires evidence), demotion (automatic on a recorded dangerous false
 * approval), the kill switch, and settings. All of it is audited, including refusals.
 * @module api/services/repo-modes
 */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { appendAudit } from '../../shared/audit.js'
import type { SessionUser } from '../../shared/auth.js'
import { canAccessOrg } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { POLICY_VERSION } from '../../shared/gate/rules.js'
import { newId } from '../../shared/ids.js'
import { loadRepo, MODEL_VERSIONS, type RepoRow } from '../../shared/repos.js'
import { invalidateActiveDecision } from '../../shared/review-state.js'
import type { DecisionRow, PrRow } from '../../shared/rows.js'
import { evaluatePromotion, type PromotionEvidence } from '../../evaluation/promotion.js'
import { latestEvaluation } from '../../evaluation/service.js'

export async function loadScopedRepo(id: string, user: SessionUser): Promise<RepoRow> {
  const repo = await loadRepo(pool, id)
  if (!repo || !canAccessOrg(user, repo.org_id)) throw notFound('Repository')
  return repo
}

/** Latest shadow decision per commit, on this model version, since any demotion. */
export async function shadowStats(repo: RepoRow): Promise<PromotionEvidence['shadow']> {
  const res = await pool.query<{ decisions: number; labeled: number; agreed: number; unsafe: number }>(
    `WITH latest AS (
       SELECT DISTINCT ON (pr_id, head_sha) would, human_outcome
       FROM decisions
       WHERE repo_id = $1 AND outcome = 'shadow' AND model_version = $2 AND ($3::timestamptz IS NULL OR created_at > $3)
       ORDER BY pr_id, head_sha, created_at DESC
     )
     SELECT count(*)::int AS decisions,
            count(human_outcome)::int AS labeled,
            count(*) FILTER (WHERE (would = 'approve' AND human_outcome = 'approved') OR (would = 'escalate' AND human_outcome = 'changes_requested'))::int AS agreed,
            count(*) FILTER (WHERE would = 'approve' AND human_outcome = 'changes_requested')::int AS unsafe
     FROM latest`,
    [repo.id, repo.model_version, repo.demoted_at],
  )
  const r = res.rows[0]
  return { decisions: r.decisions, labeled: r.labeled, agreed: r.agreed, unsafeApprovals: r.unsafe }
}

export async function promotionEvidence(repo: RepoRow): Promise<PromotionEvidence> {
  const ev = await latestEvaluation(repo.model_version)
  return {
    killSwitch: repo.kill_switch,
    modelVersion: repo.model_version,
    demotedAt: repo.demoted_at,
    evaluation: ev?.summary ? { id: ev.id, modelVersion: ev.model_version, policyVersion: ev.policy_version, partial: ev.partial, createdAt: ev.created_at, summary: ev.summary } : null,
    shadow: await shadowStats(repo),
  }
}

export async function previewPromotion(repo: RepoRow) {
  return evaluatePromotion(await promotionEvidence(repo), config.promotion)
}

async function recordModeChange(tx: PoolClient, repo: RepoRow, kind: 'promote' | 'promote_refused' | 'demote', toMode: string, actor: string, reason: string, evaluationId: string | null, checks: unknown): Promise<void> {
  await tx.query(`INSERT INTO mode_changes (id, repo_id, kind, from_mode, to_mode, actor, reason, evaluation_id, checks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [newId('mc'), repo.id, kind, repo.mode, toMode, actor, reason, evaluationId, JSON.stringify(checks)])
}

export async function promoteRepo(id: string, user: SessionUser): Promise<RepoRow> {
  const repo = await loadScopedRepo(id, user)
  if (repo.mode === 'narrow_auto') throw new HttpError(409, 'ALREADY_PROMOTED', 'This repository is already in narrow_auto')
  const evidence = await promotionEvidence(repo)
  const verdict = evaluatePromotion(evidence, config.promotion)
  const evaluationId = evidence.evaluation?.id ?? null
  if (!verdict.allowed) {
    await withTransaction(async (tx) => {
      await recordModeChange(tx, repo, 'promote_refused', repo.mode, user.username, verdict.reasons.join('; '), evaluationId, verdict.checks)
      await appendAudit(tx, { repoId: repo.id, kind: 'promotion_refused', actor: user.username, payload: { reasons: verdict.reasons, checks: verdict.checks, evaluationId, modelVersion: repo.model_version, policyVersion: POLICY_VERSION } })
    })
    throw new HttpError(409, 'PROMOTION_REFUSED', `Promotion refused: ${verdict.reasons[0]}`, { checks: verdict.checks, reasons: verdict.reasons })
  }
  return withTransaction(async (tx) => {
    await recordModeChange(tx, repo, 'promote', 'narrow_auto', user.username, 'Evaluation thresholds met', evaluationId, verdict.checks)
    const res = await tx.query<RepoRow>(`UPDATE repositories SET mode = 'narrow_auto', mode_changed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [repo.id])
    await appendAudit(tx, { repoId: repo.id, kind: 'mode_promoted', actor: user.username, payload: { from: repo.mode, to: 'narrow_auto', evaluationId, modelVersion: repo.model_version, policyVersion: POLICY_VERSION, checks: verdict.checks } })
    return res.rows[0]
  })
}

export async function demoteInTx(tx: PoolClient, repo: RepoRow, actor: string, reason: string): Promise<void> {
  if (repo.mode === 'observe') return
  await recordModeChange(tx, repo, 'demote', 'observe', actor, reason, null, [])
  await tx.query(`UPDATE repositories SET mode = 'observe', demoted_at = clock_timestamp(), demoted_reason = $2, mode_changed_at = now(), updated_at = now() WHERE id = $1`, [repo.id, reason])
  await tx.query(`UPDATE post_intents SET status = 'cancelled', outcome = 'repo_demoted', lease_token = NULL, finished_at = now() WHERE repo_id = $1 AND kind = 'approve' AND status IN ('pending','running')`, [repo.id])
  await appendAudit(tx, { repoId: repo.id, kind: 'mode_demoted', actor, payload: { from: repo.mode, to: 'observe', reason } })
}

export async function demoteRepo(id: string, user: SessionUser, reason: string): Promise<void> {
  const repo = await loadScopedRepo(id, user)
  await withTransaction((tx) => demoteInTx(tx, repo, user.username, reason))
}

export async function setKillSwitch(id: string, user: SessionUser, on: boolean, reason: string | undefined): Promise<void> {
  const repo = await loadScopedRepo(id, user)
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE repositories SET kill_switch = $2, updated_at = now() WHERE id = $1`, [repo.id, on])
    await appendAudit(tx, { repoId: repo.id, kind: 'kill_switch_changed', actor: user.username, payload: { on, reason: reason ?? null } })
  })
}

export const settingsPatch = z
  .object({
    protectedPaths: z.array(z.string().min(1).max(300)).max(200),
    ciConfigPaths: z.array(z.string().min(1).max(300)).max(200),
    policyPaths: z.array(z.string().min(1).max(300)).max(200),
    maxFiles: z.number().int().min(1).max(1000),
    maxChangedLines: z.number().int().min(1).max(100_000),
    autoApproveScope: z.array(z.enum(['docs', 'tests'])).max(2),
    requiredChecks: z.array(z.string().min(1).max(100)).max(50),
    requiredReviewers: z.array(z.string().min(1).max(100)).max(20),
    botLogins: z.array(z.string().min(1).max(100)).max(20),
    linkAllowlist: z.array(z.string().min(1).max(200)).max(200),
    modelVersion: z.enum(MODEL_VERSIONS),
  })
  .partial()
  .strict()

const COLUMNS: Record<string, string> = {
  protectedPaths: 'protected_paths',
  ciConfigPaths: 'ci_config_paths',
  policyPaths: 'policy_paths',
  maxFiles: 'max_files',
  maxChangedLines: 'max_changed_lines',
  autoApproveScope: 'auto_approve_scope',
  requiredChecks: 'required_checks',
  requiredReviewers: 'required_reviewers',
  botLogins: 'bot_logins',
  linkAllowlist: 'link_allowlist',
  modelVersion: 'model_version',
}

const JSON_COLUMNS = new Set(['protectedPaths', 'ciConfigPaths', 'policyPaths', 'autoApproveScope', 'requiredChecks', 'requiredReviewers', 'botLogins', 'linkAllowlist'])

export async function updateSettings(id: string, user: SessionUser, patch: z.infer<typeof settingsPatch>): Promise<void> {
  const repo = await loadScopedRepo(id, user)
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return
  await withTransaction(async (tx) => {
    const sets = entries.map(([k], i) => `${COLUMNS[k]} = $${i + 2}`)
    const values = entries.map(([k, v]) => (JSON_COLUMNS.has(k) ? JSON.stringify(v) : v))
    await tx.query(`UPDATE repositories SET ${sets.join(', ')}, settings_version = settings_version + 1, updated_at = now() WHERE id = $1`, [repo.id, ...values])
    await appendAudit(tx, { repoId: repo.id, kind: 'settings_changed', actor: user.username, payload: { changes: Object.fromEntries(entries), settingsVersion: repo.settings_version + 1 } })
    // Evidence for the old model says nothing about the new one.
    if (patch.modelVersion && patch.modelVersion !== repo.model_version) await demoteInTx(tx, repo, user.username, `Model changed from ${repo.model_version} to ${patch.modelVersion}`)
  })
}

/** A person says an automatic approval should never have happened. The repository goes back to observe, immediately. */
export async function reportFalseApproval(decisionId: string, user: SessionUser, note: string | undefined): Promise<{ demoted: boolean }> {
  const res = await pool.query<DecisionRow & { org_id: string }>(`SELECT d.*, r.org_id FROM decisions d JOIN repositories r ON r.id = d.repo_id WHERE d.id = $1`, [decisionId])
  const d = res.rows[0]
  if (!d || !canAccessOrg(user, d.org_id)) throw notFound('Decision')
  if (d.outcome !== 'auto_approved') throw new HttpError(422, 'NOT_AN_AUTO_APPROVAL', 'Only automatic approvals can be reported as dangerous false approvals')
  return withTransaction(async (tx) => {
    const prRes = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE id = $1 FOR UPDATE`, [d.pr_id])
    const repoRes = await tx.query<RepoRow>(`SELECT * FROM repositories WHERE id = $1 FOR UPDATE`, [d.repo_id])
    const repo = repoRes.rows[0]
    const marked = await tx.query(`UPDATE decisions SET false_approval_reported_at = now(), false_approval_reported_by = $2, false_approval_note = $3 WHERE id = $1 AND false_approval_reported_at IS NULL`, [d.id, user.username, note ?? null])
    if (!marked.rowCount) return { demoted: false }
    await appendAudit(tx, { repoId: repo.id, kind: 'false_approval_reported', actor: user.username, prNumber: d.pr_number, headSha: d.head_sha, decisionId: d.id, payload: { note: note ?? null, modelVersion: d.model_version, policyVersion: d.policy_version } })
    await demoteInTx(tx, repo, user.username, `Dangerous false approval reported on #${d.pr_number} at ${d.head_sha.slice(0, 7)}`)
    if (d.state === 'active') {
      await invalidateActiveDecision(tx, repo, prRes.rows[0], 'Reported as a dangerous false approval', user.username, null)
      await tx.query(
        `INSERT INTO escalations (id, repo_id, pr_id, pr_number, decision_id, head_sha, reason_code, reason) VALUES ($1,$2,$3,$4,$5,$6,'false_approval_reported',$7)
         ON CONFLICT (pr_id, head_sha) WHERE status IN ('open','claimed') DO NOTHING`,
        [newId('esc'), repo.id, d.pr_id, d.pr_number, d.id, d.head_sha, `Reported by ${user.username} as a dangerous false approval`],
      )
    }
    return { demoted: repo.mode === 'narrow_auto' }
  })
}
