/**
 * Evaluates accounts against every control and persists the result: batched
 * upserts for failures, one UPDATE for resolutions, an audit entry for each
 * regression (a finding that was fixed and came back).
 * @module store/findings
 */
import { CONTROLS, evaluateAccount } from '../domain/controls.js'
import { planFindings, type ExistingFinding, type FindingWrite } from '../domain/findings.js'
import type { Queryable } from '../shared/db.js'
import { audit } from './audit.js'
import { loadAccounts } from './inventory.js'

export interface EvaluationStats {
  accounts: number
  open: number
  resolved: number
  reopened: number
  created: number
}

export async function evaluateAndStore(db: Queryable, accountIds: string[], minEvidenceDays: number, now = new Date()): Promise<EvaluationStats> {
  const stats: EvaluationStats = { accounts: 0, open: 0, resolved: 0, reopened: 0, created: 0 }
  for (let i = 0; i < accountIds.length; i += 500) {
    const batch = accountIds.slice(i, i + 500)
    const loaded = await loadAccounts(db, batch)
    const { rows: existingRows } = await db.query<{ id: number; account_id: string; control_id: string; status: ExistingFinding['status']; first_seen_at: Date }>(
      'SELECT id, account_id, control_id, status, first_seen_at FROM findings WHERE account_id = ANY($1)',
      [batch],
    )
    const { rows: exemptRows } = await db.query<{ account_id: string; control_id: string }>(
      `SELECT account_id, control_id FROM exceptions WHERE status = 'approved' AND expires_at > $2 AND account_id = ANY($1)`,
      [batch, now],
    )
    const existing = new Map<string, Map<string, ExistingFinding>>()
    for (const r of existingRows) {
      const m = existing.get(r.account_id) ?? new Map<string, ExistingFinding>()
      m.set(r.control_id, { id: r.id, controlId: r.control_id, status: r.status, firstSeenAt: r.first_seen_at })
      existing.set(r.account_id, m)
    }
    const exempt = new Map<string, Set<string>>()
    for (const r of exemptRows) exempt.set(r.account_id, (exempt.get(r.account_id) ?? new Set()).add(r.control_id))

    const writes: FindingWrite[] = []
    const resolveIds: number[] = []
    for (const { snapshot, usage } of loaded) {
      const plan = planFindings(snapshot, evaluateAccount(snapshot, CONTROLS), existing.get(snapshot.id) ?? new Map(), usage, exempt.get(snapshot.id) ?? new Set(), now, minEvidenceDays)
      writes.push(...plan.writes)
      resolveIds.push(...plan.resolveIds)
    }
    stats.accounts += loaded.length
    if (writes.length > 0) {
      await db.query(
        `INSERT INTO findings (account_id, control_id, control_version, status, severity, risk_score, observed, evidence_class, evidence_reason,
           first_seen_at, last_seen_at, due_at)
         SELECT r.account_id, r.control_id, r.control_version, r.status, r.severity, r.risk_score, r.observed, r.evidence_class, r.evidence_reason,
           $2, $2, r.due_at
         FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, control_id text, control_version int, status text, severity text, risk_score int,
           observed jsonb, evidence_class text, evidence_reason text, due_at timestamptz, reopened boolean)
         ON CONFLICT (account_id, control_id) DO UPDATE SET control_version = EXCLUDED.control_version, status = EXCLUDED.status,
           severity = EXCLUDED.severity, risk_score = EXCLUDED.risk_score, observed = EXCLUDED.observed,
           evidence_class = EXCLUDED.evidence_class, evidence_reason = EXCLUDED.evidence_reason, last_seen_at = EXCLUDED.last_seen_at,
           resolved_at = NULL, due_at = EXCLUDED.due_at,
           first_seen_at = CASE WHEN findings.status = 'resolved' THEN EXCLUDED.first_seen_at ELSE findings.first_seen_at END,
           reopened_count = findings.reopened_count + CASE WHEN findings.status = 'resolved' THEN 1 ELSE 0 END`,
        [
          JSON.stringify(
            writes.map((w) => ({
              account_id: w.accountId,
              control_id: w.controlId,
              control_version: w.controlVersion,
              status: w.status,
              severity: w.severity,
              risk_score: w.riskScore,
              observed: w.observed,
              evidence_class: w.evidenceClass,
              evidence_reason: w.evidenceReason,
              due_at: w.dueAt.toISOString(),
              reopened: w.reopened,
            })),
          ),
          now,
        ],
      )
    }
    if (resolveIds.length > 0) {
      await db.query(`UPDATE findings SET status = 'resolved', resolved_at = $2, last_seen_at = $2 WHERE id = ANY($1)`, [resolveIds, now])
    }
    for (const w of writes.filter((x) => x.reopened)) {
      await audit(db, { actor: 'service:scanner', action: 'finding.reopened', accountId: w.accountId, controlId: w.controlId, after: w.observed, details: { reason: 'Setting regressed after it was fixed' } })
    }
    stats.open += writes.length
    stats.resolved += resolveIds.length
    stats.reopened += writes.filter((w) => w.reopened).length
    stats.created += writes.filter((w) => w.isNew).length
  }
  return stats
}
