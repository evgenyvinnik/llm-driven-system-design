/**
 * Posture dashboard data: per-control compliance with one shared definition,
 * history for the burn-down, and freshness so readers know how old the
 * numbers are and where they come from.
 */
import { Router } from 'express'
import { CONTROLS } from '../../domain/controls.js'
import { ownerScope, requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { computePosture } from '../../store/posture.js'

export const postureRouter = Router()

postureRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const params: unknown[] = []
    const scope = ownerScope(user, 'a', params)
    const [posture, controls, counts, critical, history, freshness] = await Promise.all([
      computePosture(pool, scope, params),
      pool.query<{ id: string; policy_effect: string }>('SELECT id, policy_effect FROM controls'),
      pool.query<{ accounts: number; subscriptions: number }>(
        `SELECT count(*)::int AS accounts, count(DISTINCT a.subscription_id)::int AS subscriptions FROM storage_accounts a WHERE a.deleted_at IS NULL AND ${scope}`,
        params,
      ),
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM findings f JOIN storage_accounts a ON a.id = f.account_id
          WHERE f.status = 'open' AND f.severity = 'critical' AND a.deleted_at IS NULL AND ${scope}`,
        params,
      ),
      // History is fleet-wide; owners see their scope's current numbers above.
      pool.query<{ taken_at: Date; control_id: string; total: number; compliant: number; open: number; source: string }>(
        `SELECT taken_at, control_id, total, compliant, open, source FROM posture_snapshots
          WHERE taken_at > now() - interval '45 days' ORDER BY taken_at`,
      ),
      pool.query<{ last_full: Date | null; last_full_ms: number | null; last_event: Date | null; cursor_at: Date | null; oldest: Date | null; newest: Date | null }>(
        `SELECT (SELECT max(finished_at) FROM scan_runs WHERE kind = 'full' AND status = 'completed') AS last_full,
                (SELECT extract(epoch FROM finished_at - started_at) * 1000 FROM scan_runs WHERE kind = 'full' AND status = 'completed' ORDER BY finished_at DESC LIMIT 1) AS last_full_ms,
                (SELECT max(last_event_at) FROM scanner_cursors) AS last_event,
                (SELECT max(updated_at) FROM scanner_cursors) AS cursor_at,
                (SELECT min(observed_at) FROM storage_accounts WHERE deleted_at IS NULL) AS oldest,
                (SELECT max(observed_at) FROM storage_accounts WHERE deleted_at IS NULL) AS newest`,
      ),
    ])
    const effect = new Map(controls.rows.map((r) => [r.id, r.policy_effect]))
    const byTime = new Map<string, { takenAt: string; source: string; open: number; compliant: number; total: number; controls: Record<string, number> }>()
    for (const h of history.rows) {
      const key = h.taken_at.toISOString()
      const point = byTime.get(key) ?? { takenAt: key, source: h.source, open: 0, compliant: 0, total: 0, controls: {} }
      point.open += h.open
      point.compliant += h.compliant
      point.total += h.total
      point.controls[h.control_id] = h.total > 0 ? Math.round((h.compliant / h.total) * 1000) / 10 : 0
      byTime.set(key, point)
    }
    const sum = posture.reduce((acc, p) => ({ compliant: acc.compliant + p.compliant, total: acc.total + p.total, open: acc.open + p.open, exempt: acc.exempt + p.exempt }), { compliant: 0, total: 0, open: 0, exempt: 0 })
    const f = freshness.rows[0]
    res.json({
      scope: user.role === 'owner' ? { kind: 'team', team: user.team } : { kind: 'fleet' },
      fleet: {
        accounts: counts.rows[0].accounts,
        subscriptions: counts.rows[0].subscriptions,
        openFindings: sum.open,
        criticalOpen: critical.rows[0].n,
        exempt: sum.exempt,
        compliancePct: sum.total > 0 ? Math.round((sum.compliant / sum.total) * 1000) / 10 : 0,
      },
      controls: CONTROLS.map((c) => {
        const p = posture.find((x) => x.controlId === c.id)
        return {
          id: c.id,
          key: c.key,
          title: c.title,
          severity: c.severity,
          kind: c.kind,
          breaking: c.breaking,
          policyEffect: effect.get(c.id) ?? 'audit',
          ...(p ?? { total: 0, compliant: 0, open: 0, exempt: 0, compliancePct: 0, evidence: { safe_to_fix: 0, needs_owner_migration: 0, insufficient_evidence: 0 }, inRemediation: 0 }),
        }
      }),
      history: [...byTime.values()],
      freshness: {
        lastFullScanAt: f.last_full,
        lastFullScanMs: f.last_full_ms === null ? null : Math.round(Number(f.last_full_ms)),
        lastChangeEventAt: f.last_event,
        changeFeedPolledAt: f.cursor_at,
        oldestObservationAt: f.oldest,
        newestObservationAt: f.newest,
      },
    })
  }),
)
