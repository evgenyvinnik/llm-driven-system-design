/**
 * Yard workflow: the inspection queue (work orders), car holds, the outbound
 * build check, and inspection findings. Queues and holds read the alert-queue
 * projection; starting an inspection and recording a finding are commands on
 * the case aggregate. The outbound build check reads the write-side hold index
 * (case_index), never a projection: a stale "clear" could let a held car out.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { clockInfo } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { YARDS, yardById } from '../../shared/network.js'
import { workOrderDto, type WorkOrderRow } from '../dto.js'
import { findingSchema, recordFinding, startWorkOrder } from '../services/commands.js'

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
              f.finding, f.disposition, f.notes AS finding_notes, f.recorded_by,
              (SELECT h.status FROM car_holds h WHERE h.alert_id = w.alert_id ORDER BY (h.status = 'released'), h.created_at DESC LIMIT 1) AS hold_status
         FROM work_orders w LEFT JOIN alerts a ON a.id = w.alert_id JOIN trips t ON t.trip_id = COALESCE(a.trip_id, w.trip_id)
         LEFT JOIN findings f ON f.work_order_id = w.id AND f.superseded_by IS NULL
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
      `SELECT c.car_id, c.hold_status AS status, c.hold_yard_id AS yard_id, c.kind, c.position
         FROM case_index c WHERE c.car_id = ANY($1) AND c.hold_status IN ('active', 'bad_ordered')`,
      [normalized],
    )
    const blocked = rows.map((r) => ({
      carId: r.car_id, status: r.status, yardId: r.yard_id,
      reason: `${r.status === 'bad_ordered' ? 'Bad-ordered' : 'Held'} for ${String(r.kind).replace('_', ' ')}${r.position === 'CAR' ? '' : ` ${r.position}`}: inspect before building into an outbound train`,
    }))
    res.json({ blocked, clear: normalized.filter((c) => !blocked.some((b) => b.carId === c)) })
  }),
)

workOrdersRouter.post(
  '/:id/start',
  requireRole('yard'),
  asyncHandler(async (req, res) => {
    const state = await startWorkOrder(req.params.id, req.user!)
    const wo = state.workOrder!
    res.json({ workOrder: { id: wo.workOrderId, status: wo.status, assignedTo: wo.assignedTo, yardId: wo.yardId, version: state.version } })
  }),
)

workOrdersRouter.post(
  '/:id/finding',
  requireRole('yard'),
  asyncHandler(async (req, res) => {
    const input = findingSchema.parse(req.body)
    const result = await recordFinding(req.params.id, input, req.user!)
    res.status(result.replayed ? 200 : 201).json({ finding: { id: result.findingId }, replayed: result.replayed, superseded: result.superseded, caseVersion: result.state.version })
  }),
)
