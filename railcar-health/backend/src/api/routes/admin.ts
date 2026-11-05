/**
 * Reliability engineering: thresholds (versioned, with a backtest against
 * inspection findings) and precision/recall metrics from those findings.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { DEFAULT_THRESHOLDS, TIER_NAMES, type Thresholds } from '../../shared/domain.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { invalidateThresholds, loadThresholds, normalizeThresholds } from '../../shared/thresholds.js'
import { backtest, type LabeledAlert } from '../services/backtest.js'

export const adminRouter = Router()
adminRouter.use(requireRole('admin'))

const thresholdShape = Object.fromEntries(
  Object.keys(DEFAULT_THRESHOLDS).map((k) => [k, z.number().min(0).max(1000)]),
) as Record<keyof Thresholds, z.ZodNumber>
const thresholdsSchema = z.object(thresholdShape).strict()

adminRouter.get(
  '/thresholds',
  asyncHandler(async (_req, res) => {
    const current = await loadThresholds(pool, true)
    const meta = (await pool.query('SELECT updated_by, updated_at FROM thresholds WHERE id = 1')).rows[0]
    const history = await pool.query('SELECT version, changed_by, changed_at FROM threshold_changes ORDER BY id DESC LIMIT 10')
    res.json({
      config: current.config,
      version: current.version,
      defaults: DEFAULT_THRESHOLDS,
      updatedBy: meta?.updated_by ?? null,
      updatedAt: meta?.updated_at ?? null,
      history: history.rows.map((h) => ({ version: h.version, changedBy: h.changed_by, changedAt: h.changed_at })),
    })
  }),
)

adminRouter.put(
  '/thresholds',
  asyncHandler(async (req, res) => {
    const body = z.object({ version: z.number().int().min(0), config: thresholdsSchema }).parse(req.body)
    const result = await withTransaction(async (client) => {
      const updated = await client.query<{ version: number }>(
        `UPDATE thresholds SET config = $1, version = version + 1, updated_by = $2, updated_at = now() WHERE id = 1 AND version = $3 RETURNING version`,
        [body.config, req.user!.username, body.version],
      )
      if (updated.rowCount === 0) return null
      await client.query('INSERT INTO threshold_changes (version, config, changed_by) VALUES ($1, $2, $3)', [updated.rows[0].version, body.config, req.user!.username])
      return updated.rows[0].version
    })
    if (result === null) {
      const current = await loadThresholds(pool, true)
      throw new HttpError(409, 'STALE_VERSION', 'Thresholds were changed by someone else', current)
    }
    invalidateThresholds()
    res.json({ config: body.config, version: result })
  }),
)

async function labeledAlerts(): Promise<LabeledAlert[]> {
  const { rows } = await pool.query<{ kind: string; tier: number; features: LabeledAlert['features']; finding: string }>(
    `SELECT a.kind, a.tier, a.features, f.finding FROM findings f JOIN alerts a ON a.id = f.alert_id WHERE f.source = 'alert'`,
  )
  return rows.map((r) => ({ kind: r.kind, tier: r.tier, features: r.features, defect: r.finding !== 'no_defect_found' }))
}

adminRouter.post(
  '/thresholds/preview',
  asyncHandler(async (req, res) => {
    const proposed = normalizeThresholds(thresholdsSchema.parse(req.body.config))
    const current = await loadThresholds(pool, true)
    res.json(backtest(await labeledAlerts(), current.config, proposed))
  }),
)

adminRouter.get(
  '/metrics',
  asyncHandler(async (_req, res) => {
    const [byTier, recall, volume, ingest, carPasses, open, outcomes, byKind, audits, lifecycle] = await Promise.all([
      pool.query<{ tier: number; inspected: number; defects: number; ndf: number }>(
        `SELECT a.tier, count(*)::int AS inspected, count(*) FILTER (WHERE f.finding <> 'no_defect_found')::int AS defects,
                count(*) FILTER (WHERE f.finding = 'no_defect_found')::int AS ndf
           FROM findings f JOIN alerts a ON a.id = f.alert_id WHERE f.source = 'alert' GROUP BY a.tier`,
      ),
      // Recall proxy: of every confirmed defect (alert-driven or found on routine inspection), how many had an actionable alert first.
      pool.query<{ defects: number; alerted: number }>(
        `SELECT count(*)::int AS defects,
                count(*) FILTER (WHERE f.source = 'alert' AND a.tier >= 2)::int AS alerted
           FROM findings f LEFT JOIN alerts a ON a.id = f.alert_id WHERE f.finding <> 'no_defect_found'`,
      ),
      pool.query<{ tier: number; n: number }>(`SELECT tier, count(*)::int AS n FROM alerts GROUP BY tier`),
      pool.query<{ passes: number; late: number; unresolved: number; awaiting: number; median_lag: number | null }>(
        `SELECT count(*)::int AS passes, count(*) FILTER (WHERE lag_seconds > $1)::int AS late,
                count(*) FILTER (WHERE identity_status = 'unresolved')::int AS unresolved,
                count(*) FILTER (WHERE identity_status = 'awaiting_consist')::int AS awaiting,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_seconds) AS median_lag
           FROM detector_passes`,
        [config.analysis.lateAfterMinutes * 60],
      ),
      pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM axle_readings WHERE car_id IS NOT NULL AND car_axle = 1 AND rail = 'N'`),
      pool.query<{ work: number; holds: number; alerts: number }>(
        `SELECT (SELECT count(*)::int FROM work_orders WHERE status IN ('open', 'in_progress')) AS work,
                (SELECT count(*)::int FROM car_holds WHERE status = 'active') AS holds,
                (SELECT count(*)::int FROM alerts WHERE status <> 'closed') AS alerts`,
      ),
      pool.query<{ finding: string; n: number }>(`SELECT finding, count(*)::int AS n FROM findings GROUP BY finding`),
      // Bearings and brakes are different failure modes; their precision is tracked apart.
      pool.query<{ kind: string; inspected: number; defects: number }>(
        `SELECT a.kind, count(*)::int AS inspected, count(*) FILTER (WHERE f.finding <> 'no_defect_found')::int AS defects
           FROM findings f JOIN alerts a ON a.id = f.alert_id WHERE f.source = 'alert' GROUP BY a.kind`,
      ),
      // Label bias: only flagged cars get inspected. Random audits of unflagged cars estimate what is missed.
      pool.query<{ audits: number; audit_defects: number; open_audits: number }>(
        `SELECT count(*) FILTER (WHERE source = 'audit')::int AS audits,
                count(*) FILTER (WHERE source = 'audit' AND finding <> 'no_defect_found')::int AS audit_defects,
                (SELECT count(*)::int FROM work_orders WHERE kind = 'audit' AND status IN ('open', 'in_progress')) AS open_audits
           FROM findings`,
      ),
      pool.query<{ status: string; n: number; escalated: number; median_ack_min: number | null }>(
        `SELECT a.status, count(*)::int AS n, count(*) FILTER (WHERE a.escalation_level > 0)::int AS escalated,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.acknowledged_at - a.opened_at)) / 60) AS median_ack_min
           FROM alerts a WHERE a.trip_id NOT LIKE 'HIST-%' GROUP BY a.status`,
      ),
    ])
    const r = recall.rows[0]
    const liveAlerts = volume.rows.reduce((s, v) => s + v.n, 0)
    res.json({
      precisionByTier: [4, 3, 2, 1].map((tier) => {
        const row = byTier.rows.find((b) => b.tier === tier)
        return { tier, tierName: TIER_NAMES[tier], inspected: row?.inspected ?? 0, defects: row?.defects ?? 0, noDefectFound: row?.ndf ?? 0, precision: row?.inspected ? row.defects / row.inspected : null }
      }),
      recall: { confirmedDefects: r.defects, alertedFirst: r.alerted, value: r.defects ? r.alerted / r.defects : null },
      alertVolume: {
        byTier: [4, 3, 2, 1].map((tier) => ({ tier, tierName: TIER_NAMES[tier], alerts: volume.rows.find((v) => v.tier === tier)?.n ?? 0 })),
        carPasses: carPasses.rows[0].n,
        per1000CarPasses: carPasses.rows[0].n ? (liveAlerts / carPasses.rows[0].n) * 1000 : null,
      },
      ingest: { ...ingest.rows[0], lateAfterMinutes: config.analysis.lateAfterMinutes },
      open: open.rows[0],
      outcomes: outcomes.rows,
      precisionByKind: byKind.rows.map((k) => ({ kind: k.kind, inspected: k.inspected, defects: k.defects, precision: k.inspected ? k.defects / k.inspected : null })),
      audits: { ...audits.rows[0], defectRate: audits.rows[0].audits ? audits.rows[0].audit_defects / audits.rows[0].audits : null },
      lifecycle: lifecycle.rows,
    })
  }),
)
