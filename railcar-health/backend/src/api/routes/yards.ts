/**
 * Yard workflow: the inspection queue (work orders), car holds, the outbound
 * build check, and inspection findings.
 */
import { Router } from 'express'
import { z } from 'zod'
import { canActOnYard, requireAuth, requireRole } from '../../shared/auth.js'
import { clockInfo, now } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { publishEvents } from '../../shared/events.js'
import { YARDS, yardById } from '../../shared/network.js'
import { workOrderDto, type WorkOrderRow } from '../dto.js'
import { findingSchema, recordFinding } from '../services/findings.js'

export const yardsRouter = Router()
export const workOrdersRouter = Router()
yardsRouter.use(requireAuth)
workOrdersRouter.use(requireAuth)

function checkYard(req: { user?: { role: string; yardId: string | null } }, yardId: string): void {
  if (!yardById(yardId)) throw notFound('Yard')
  if (req.user!.role === 'yard' && req.user!.yardId !== yardId) throw new HttpError(403, 'FORBIDDEN', 'Inspectors see their own yard only')
}

yardsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<{ yard_id: string; open_work: number; active_holds: number }>(
      `SELECT y.id AS yard_id,
              (SELECT count(*)::int FROM work_orders w WHERE w.yard_id = y.id AND w.status IN ('open', 'in_progress')) AS open_work,
              (SELECT count(*)::int FROM car_holds h WHERE h.yard_id = y.id AND h.status <> 'released') AS active_holds
         FROM yards y`,
    )
    res.json({ yards: YARDS.map((y) => ({ ...y, openWork: rows.find((r) => r.yard_id === y.id)?.open_work ?? 0, activeHolds: rows.find((r) => r.yard_id === y.id)?.active_holds ?? 0 })) })
  }),
)

yardsRouter.get(
  '/:yardId/work-orders',
  asyncHandler(async (req, res) => {
    checkYard(req, req.params.yardId)
    const status = req.query.status === 'completed' ? ['completed', 'cancelled'] : ['open', 'in_progress']
    const { rows } = await pool.query<WorkOrderRow>(
      `SELECT w.*, t.symbol, t.trip_id, t.status AS trip_status, t.next_yard_eta, t.arrived_at, a.reasons, a.route_note, a.late, a.data_lag_seconds,
              a.status AS alert_status, a.ack_due_at, a.escalation_level,
              f.finding, f.disposition, f.notes AS finding_notes, f.recorded_by, h.status AS hold_status
         FROM work_orders w LEFT JOIN alerts a ON a.id = w.alert_id JOIN trips t ON t.trip_id = COALESCE(a.trip_id, w.trip_id)
         LEFT JOIN findings f ON f.work_order_id = w.id LEFT JOIN car_holds h ON h.alert_id = w.alert_id
        WHERE w.yard_id = $1 AND w.status = ANY($2)
        ORDER BY w.priority DESC, w.created_at ${status[0] === 'completed' ? 'DESC' : 'ASC'} LIMIT 100`,
      [req.params.yardId, status],
    )
    res.json({ workOrders: rows.map(workOrderDto), clock: clockInfo() })
  }),
)

yardsRouter.get(
  '/:yardId/holds',
  asyncHandler(async (req, res) => {
    checkYard(req, req.params.yardId)
    const { rows } = await pool.query(
      `SELECT h.*, a.tier, a.position, a.kind FROM car_holds h JOIN alerts a ON a.id = h.alert_id
        WHERE h.yard_id = $1 AND (h.status <> 'released' OR h.released_at IS NOT NULL) ORDER BY (h.status = 'released'), h.created_at DESC LIMIT 100`,
      [req.params.yardId],
    )
    res.json({
      holds: rows.map((h) => ({
        id: h.id, carId: h.car_id, alertId: h.alert_id, yardId: h.yard_id, status: h.status, reason: h.reason, createdAt: h.created_at,
        releasedAt: h.released_at, releasedBy: h.released_by, tier: h.tier, position: h.position, kind: h.kind,
      })),
      clock: clockInfo(),
    })
  }),
)

const outboundSchema = z.object({ carIds: z.array(z.string().min(1).max(32)).min(1).max(300) })

/** The yard's train-building system asks before it adds cars to an outbound train. */
yardsRouter.post(
  '/:yardId/outbound-check',
  asyncHandler(async (req, res) => {
    checkYard(req, req.params.yardId)
    const { carIds } = outboundSchema.parse(req.body)
    const normalized = carIds.map((c) => c.trim().toUpperCase().replace(/\s+/g, ' '))
    const { rows } = await pool.query(
      `SELECT h.car_id, h.status, h.reason, h.yard_id FROM car_holds h WHERE h.car_id = ANY($1) AND h.status <> 'released'`,
      [normalized],
    )
    const blocked = rows.map((r) => ({ carId: r.car_id, status: r.status, reason: r.reason, yardId: r.yard_id }))
    res.json({ blocked, clear: normalized.filter((c) => !blocked.some((b) => b.carId === c)) })
  }),
)

workOrdersRouter.post(
  '/:id/start',
  requireRole('yard'),
  asyncHandler(async (req, res) => {
    const wo = (await pool.query('SELECT yard_id, status, alert_id FROM work_orders WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }))).rows[0]
    if (!wo) throw notFound('Work order')
    if (!canActOnYard(req.user!, wo.yard_id)) throw new HttpError(403, 'FORBIDDEN', 'This work order belongs to another yard')
    const updated = await pool.query<WorkOrderRow>(
      `UPDATE work_orders SET status = 'in_progress', assigned_to = $2, version = version + 1 WHERE id = $1 AND status = 'open' RETURNING *`,
      [req.params.id, req.user!.username],
    )
    if (updated.rowCount === 0) throw new HttpError(409, 'NOT_OPEN', 'Work order is not open')
    // Starting the inspection is the yard's acknowledgment: a person now owns it.
    if (wo.alert_id) {
      const at = now()
      const acked = await pool.query(
        `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3, ack_action = 'inspection_started', updated_at = $3, version = version + 1
          WHERE id = $1 AND status = 'open' AND owner_role = 'yard' RETURNING tier`,
        [wo.alert_id, req.user!.username, at],
      )
      if (acked.rows[0]) {
        await pool.query(`INSERT INTO alert_events (alert_id, kind, tier, note, actor, at) VALUES ($1, 'acknowledged', $2, 'Inspection started', $3, $4) ON CONFLICT DO NOTHING`, [
          wo.alert_id, acked.rows[0].tier, req.user!.username, at,
        ])
      }
    }
    await publishEvents([{ type: 'workorder.updated', yardId: wo.yard_id }, ...(wo.alert_id ? [{ type: 'alert.updated' as const, alertId: wo.alert_id, yardId: wo.yard_id }] : [])])
    res.json({ workOrder: workOrderDto(updated.rows[0]) })
  }),
)

workOrdersRouter.post(
  '/:id/finding',
  requireRole('yard'),
  asyncHandler(async (req, res) => {
    const input = findingSchema.parse(req.body)
    const result = await recordFinding(req.params.id, input, req.user!)
    await publishEvents(result.events)
    res.status(result.replayed ? 200 : 201).json({ finding: result.finding, replayed: result.replayed })
  }),
)
