/**
 * The human queue. Everything uncertain or failed lands here. A person claims an
 * item so two people don't duplicate the work, and decides against the exact SHA
 * they read: a mismatch is refused, and a later push invalidates the decision.
 * @module api/services/escalations
 */
import { appendAudit } from '../../shared/audit.js'
import type { SessionUser } from '../../shared/auth.js'
import { canAccessOrg } from '../../shared/auth.js'
import { humanApprovalBody } from '../../shared/comment.js'
import { pool, withTransaction } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { POLICY_VERSION } from '../../shared/gate/rules.js'
import { newId } from '../../shared/ids.js'
import { sanitizeForComment } from '../../shared/model-output.js'
import { loadRepo } from '../../shared/repos.js'
import { createIntent } from '../../shared/review-state.js'
import type { DecisionRow, EscalationRow, PrRow } from '../../shared/rows.js'

async function loadScoped(id: string, user: SessionUser): Promise<EscalationRow> {
  const res = await pool.query<EscalationRow & { org_id: string }>(`SELECT e.*, r.org_id FROM escalations e JOIN repositories r ON r.id = e.repo_id WHERE e.id = $1`, [id])
  const row = res.rows[0]
  if (!row || !canAccessOrg(user, row.org_id)) throw notFound('Escalation')
  return row
}

export async function claimEscalation(id: string, user: SessionUser): Promise<void> {
  const e = await loadScoped(id, user)
  await withTransaction(async (tx) => {
    const res = await tx.query(`UPDATE escalations SET status = 'claimed', claimed_by = $2, claimed_at = now() WHERE id = $1 AND status = 'open'`, [id, user.username])
    if (!res.rowCount) throw new HttpError(409, 'NOT_CLAIMABLE', 'This item is already claimed, decided or out of date')
    await appendAudit(tx, { repoId: e.repo_id, kind: 'escalation_claimed', actor: user.username, prNumber: e.pr_number, headSha: e.head_sha, payload: { escalationId: id } })
  })
}

export async function releaseEscalation(id: string, user: SessionUser): Promise<void> {
  const e = await loadScoped(id, user)
  await withTransaction(async (tx) => {
    const res = await tx.query(`UPDATE escalations SET status = 'open', claimed_by = NULL, claimed_at = NULL WHERE id = $1 AND status = 'claimed' AND claimed_by = $2`, [id, user.username])
    if (!res.rowCount) throw new HttpError(409, 'NOT_CLAIMED', 'You do not hold this item')
    await appendAudit(tx, { repoId: e.repo_id, kind: 'escalation_released', actor: user.username, prNumber: e.pr_number, headSha: e.head_sha, payload: { escalationId: id } })
  })
}

export async function decideEscalation(id: string, user: SessionUser, body: { decision: 'approve' | 'reject'; headSha: string; note?: string }): Promise<{ decisionId: string }> {
  const scoped = await loadScoped(id, user)
  const repo = await loadRepo(pool, scoped.repo_id)
  if (!repo) throw notFound('Repository')
  return withTransaction(async (tx) => {
    // The same lock a push takes, so "still the head" stays true for this whole transaction.
    const prRes = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE id = $1 FOR UPDATE`, [scoped.pr_id])
    const pr = prRes.rows[0]
    const eRes = await tx.query<EscalationRow>(`SELECT * FROM escalations WHERE id = $1 FOR UPDATE`, [id])
    const e = eRes.rows[0]
    if (e.status === 'invalidated' || body.headSha !== e.head_sha || pr.head_sha !== e.head_sha) {
      throw new HttpError(409, 'STALE_SHA', `This item is for ${e.head_sha.slice(0, 7)}, the head is ${pr.head_sha.slice(0, 7)}, and you reviewed ${body.headSha.slice(0, 7)}`, { itemSha: e.head_sha, currentHead: pr.head_sha })
    }
    if (e.status !== 'claimed' || e.claimed_by !== user.username) throw new HttpError(409, 'NOT_CLAIMED', 'Claim this item before deciding it')
    if (body.decision === 'approve' && pr.author === user.username) throw new HttpError(403, 'SELF_APPROVAL', 'Authors cannot approve their own pull request')

    const resolution = body.decision === 'approve' ? 'approved' : 'rejected'
    const note = body.note?.trim() ? body.note.trim().slice(0, 1000) : null
    await tx.query(`UPDATE escalations SET status = 'decided', decided_by = $2, decided_at = now(), resolution = $3, note = $4 WHERE id = $1`, [id, user.username, resolution, note])

    const prior = await tx.query<DecisionRow>(`UPDATE decisions SET state = 'invalidated', invalidated_reason = $2, invalidated_at = now() WHERE pr_id = $1 AND state = 'active' RETURNING *`, [pr.id, `Decided by ${user.username}`])
    const before = prior.rows[0]
    const inserted = await tx.query<DecisionRow>(
      `INSERT INTO decisions (id, repo_id, pr_id, pr_number, run_id, head_sha, mode, outcome, would, reason_code, reason, policy_version, settings_version, category, gate, model_version, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'human_decision',$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        newId('dec'),
        repo.id,
        pr.id,
        pr.number,
        before?.run_id ?? null,
        pr.head_sha,
        repo.mode,
        body.decision === 'approve' ? 'human_approved' : 'human_rejected',
        body.decision === 'approve' ? 'approve' : 'escalate',
        `${body.decision === 'approve' ? 'Approved' : 'Rejected'} by ${user.username} at ${pr.head_sha.slice(0, 7)}${note ? `: ${note}` : ''}`,
        before?.policy_version ?? POLICY_VERSION,
        repo.settings_version,
        before?.category ?? null,
        before?.gate ? JSON.stringify(before.gate) : null,
        before?.model_version ?? null,
        user.username,
      ],
    )
    const decision = inserted.rows[0]
    await appendAudit(tx, { repoId: repo.id, kind: 'escalation_decided', actor: user.username, prNumber: pr.number, headSha: pr.head_sha, decisionId: decision.id, payload: { escalationId: id, resolution, note, reviewedSha: body.headSha } })
    if (body.decision === 'approve') {
      await createIntent(tx, repo, pr, decision.id, pr.head_sha, 'approve', humanApprovalBody(pr.head_sha, user.username, note), user.username)
    } else {
      await createIntent(tx, repo, pr, decision.id, pr.head_sha, 'comment', `Rejected by ${user.username} in the review console for commit ${pr.head_sha}.${note ? ` Note: ${sanitizeForComment(note, 300)}` : ''}`, user.username)
    }
    return { decisionId: decision.id }
  })
}
