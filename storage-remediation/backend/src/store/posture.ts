/**
 * Posture numbers, with one definition used everywhere (dashboard, snapshots,
 * the deny-policy guardrail):
 * - total: live accounts whose relevant resource has been read for this control
 * - open / exempt: findings in that state
 * - compliant: total - open - exempt
 * - compliance %: compliant / total (exempt accounts are not counted as compliant)
 * @module store/posture
 */
import type { Queryable } from '../shared/db.js'

export interface ControlPosture {
  controlId: string
  total: number
  compliant: number
  open: number
  exempt: number
  compliancePct: number
  evidence: { safe_to_fix: number; needs_owner_migration: number; insufficient_evidence: number }
  inRemediation: number
}

/** `scopeSql` filters storage_accounts (alias a); pass 'TRUE' for the whole fleet. */
export async function computePosture(db: Queryable, scopeSql = 'TRUE', params: unknown[] = []): Promise<ControlPosture[]> {
  const { rows } = await db.query<{
    control_id: string
    total: number
    open: number
    exempt: number
    safe: number
    migrate: number
    insufficient: number
    in_remediation: number
  }>(
    `WITH scoped AS (SELECT * FROM storage_accounts a WHERE a.deleted_at IS NULL AND ${scopeSql}),
     totals AS (
       SELECT c.id AS control_id, count(s.id) FILTER (WHERE c.kind = 'account' OR (c.kind = 'blobService' AND s.blob_service IS NOT NULL)
                OR (c.kind = 'diagnostics' AND s.diagnostics IS NOT NULL))::int AS total
         FROM controls c CROSS JOIN scoped s GROUP BY c.id),
     f AS (
       SELECT f.control_id,
              count(*) FILTER (WHERE f.status = 'open')::int AS open,
              count(*) FILTER (WHERE f.status = 'exempt')::int AS exempt,
              count(*) FILTER (WHERE f.status = 'open' AND f.evidence_class = 'safe_to_fix')::int AS safe,
              count(*) FILTER (WHERE f.status = 'open' AND f.evidence_class = 'needs_owner_migration')::int AS migrate,
              count(*) FILTER (WHERE f.status = 'open' AND f.evidence_class = 'insufficient_evidence')::int AS insufficient
         FROM findings f JOIN scoped s ON s.id = f.account_id GROUP BY f.control_id),
     r AS (
       SELECT c.control_id, count(DISTINCT t.account_id)::int AS in_remediation
         FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id JOIN scoped s ON s.id = t.account_id
        WHERE t.state IN ('queued', 'applying', 'baking', 'rolling_back') GROUP BY c.control_id)
     SELECT t.control_id, t.total, COALESCE(f.open, 0) AS open, COALESCE(f.exempt, 0) AS exempt, COALESCE(f.safe, 0) AS safe,
            COALESCE(f.migrate, 0) AS migrate, COALESCE(f.insufficient, 0) AS insufficient, COALESCE(r.in_remediation, 0) AS in_remediation
       FROM totals t LEFT JOIN f ON f.control_id = t.control_id LEFT JOIN r ON r.control_id = t.control_id
      ORDER BY t.control_id`,
    params,
  )
  return rows.map((r) => {
    const compliant = Math.max(0, r.total - r.open - r.exempt)
    return {
      controlId: r.control_id,
      total: r.total,
      compliant,
      open: r.open,
      exempt: r.exempt,
      compliancePct: r.total > 0 ? Math.round((compliant / r.total) * 1000) / 10 : 0,
      evidence: { safe_to_fix: r.safe, needs_owner_migration: r.migrate, insufficient_evidence: r.insufficient },
      inRemediation: r.in_remediation,
    }
  })
}

export async function snapshotPosture(db: Queryable, at = new Date(), source: 'scan' | 'seed' = 'scan'): Promise<ControlPosture[]> {
  const posture = await computePosture(db)
  for (const p of posture) {
    await db.query(
      `INSERT INTO posture_snapshots (taken_at, control_id, total, compliant, open, exempt, source) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (taken_at, control_id) DO NOTHING`,
      [at, p.controlId, p.total, p.compliant, p.open, p.exempt, source],
    )
  }
  return posture
}
