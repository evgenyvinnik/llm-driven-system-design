/**
 * Alert queue and alert detail. Dispatchers and reliability engineers see every
 * alert (filtered by territory in the UI); yard inspectors only their yard's.
 * Acknowledging uses optimistic concurrency on the alert's version, which only
 * changes on decisions (tier, status), not on new telemetry.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { clockInfo, now } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { publishEvents } from '../../shared/events.js'
import { SUBDIVISIONS } from '../../shared/network.js'
import { alertDto, type AlertRow } from '../dto.js'

export const alertsRouter = Router()
alertsRouter.use(requireAuth)

const listSchema = z.object({
  status: z.enum(['active', 'closed', 'all']).default('active'),
  minTier: z.coerce.number().int().min(1).max(4).optional(),
  tier: z.coerce.number().int().min(1).max(4).optional(),
  territory: z.string().optional(),
  yard: z.string().optional(),
  tripId: z.string().optional(),
  carId: z.string().optional(),
  late: z.enum(['true', 'false']).optional(),
})

const SELECT = `
  SELECT a.*, t.symbol, t.direction, t.status AS trip_status, c.owner_mark,
         wo.id AS work_order_id, wo.status AS work_order_status, h.status AS hold_status
    FROM alerts a
    JOIN trips t ON t.trip_id = a.trip_id
    LEFT JOIN railcars c ON c.car_id = a.car_id
    LEFT JOIN work_orders wo ON wo.alert_id = a.id
    LEFT JOIN car_holds h ON h.alert_id = a.id`

alertsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listSchema.parse(req.query)
    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown) => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }
    if (q.status === 'active') where.push(`a.status <> 'closed'`)
    if (q.status === 'closed') where.push(`a.status = 'closed'`)
    // A desk id expands to the subdivisions it covers.
    if (q.territory) {
      const subs = SUBDIVISIONS.filter((s) => s.id === q.territory || s.deskId === q.territory).map((s) => s.id)
      add('a.territory_id = ANY(?)', subs.length ? subs : [q.territory])
    }
    if (req.user!.role === 'yard') add('a.yard_id = ?', req.user!.yardId)
    else if (q.yard) add('a.yard_id = ?', q.yard)
    if (q.tripId) add('a.trip_id = ?', q.tripId)
    if (q.carId) add('a.car_id = ?', q.carId)
    if (q.late) add('a.late = ?', q.late === 'true')
    const countsWhere = [...where]
    const countsParams = [...params]
    if (q.tier) add('a.tier = ?', q.tier)
    if (q.minTier) add('a.tier >= ?', q.minTier)
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (a.status = 'closed'), (a.status = 'acknowledged'), a.tier DESC, COALESCE(a.escalated_at, a.opened_at) DESC LIMIT 300`
    const [list, counts] = await Promise.all([
      pool.query<AlertRow>(sql, params),
      pool.query<{ tier: number; n: number }>(
        `SELECT a.tier, count(*)::int AS n FROM alerts a ${countsWhere.length ? `WHERE ${countsWhere.join(' AND ')}` : ''} GROUP BY a.tier`,
        countsParams,
      ),
    ])
    res.json({
      alerts: list.rows.map(alertDto),
      counts: Object.fromEntries([1, 2, 3, 4].map((t) => [t, counts.rows.find((r) => r.tier === t)?.n ?? 0])),
      clock: clockInfo(),
    })
  }),
)

alertsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<AlertRow>(`${SELECT} WHERE a.id = $1`, [req.params.id]).catch(() => ({ rows: [] as AlertRow[] }))
    const alert = rows[0]
    if (!alert) throw notFound('Alert')
    if (req.user!.role === 'yard' && alert.yard_id !== req.user!.yardId) throw notFound('Alert')
    const [events, notifications] = await Promise.all([
      pool.query('SELECT kind, tier, detector_id, pass_id, note, actor, at FROM alert_events WHERE alert_id = $1 ORDER BY at, id', [alert.id]),
      pool.query('SELECT channel, target, kind, message, created_at FROM notifications WHERE alert_id = $1 ORDER BY created_at, id', [alert.id]),
    ])
    res.json({
      alert: alertDto(alert),
      events: events.rows.map((e) => ({ kind: e.kind, tier: e.tier, detectorId: e.detector_id, passId: e.pass_id, note: e.note, actor: e.actor, at: e.at })),
      notifications: notifications.rows.map((n) => ({ channel: n.channel, target: n.target, kind: n.kind, message: n.message, createdAt: n.created_at })),
      clock: clockInfo(),
    })
  }),
)

const ackSchema = z.object({
  version: z.number().int().min(1),
  action: z.enum(['stop_ordered', 'setout_planned', 'restricted_speed', 'inspect_at_terminal', 'brake_inspection', 'monitor', 'will_inspect_on_arrival']),
  note: z.string().max(500).optional(),
})

alertsRouter.post(
  '/:id/acknowledge',
  requireRole('dispatcher', 'yard'),
  asyncHandler(async (req, res) => {
    const body = ackSchema.parse(req.body)
    const at = now()
    // The owner acknowledges: a dispatcher for train-handling alerts, the yard's inspectors for car-inspection ones.
    const owner = (await pool.query<{ owner_role: string | null; owner_id: string | null }>('SELECT owner_role, owner_id FROM alerts WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }))).rows[0]
    if (!owner) throw notFound('Alert')
    const u = req.user!
    const allowed = u.role === 'admin' || (u.role === 'dispatcher' && owner.owner_role === 'dispatcher') || (u.role === 'yard' && owner.owner_role === 'yard' && owner.owner_id === u.yardId)
    if (!allowed) throw new HttpError(403, 'NOT_OWNER', `This alert is owned by the ${owner.owner_role ?? 'unknown'} ${owner.owner_id ?? ''}`.trim())
    const updated = await pool.query<AlertRow>(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $3, acknowledged_at = $4, ack_action = $5, ack_note = $6,
              updated_at = $4, version = version + 1
        WHERE id = $1 AND version = $2 AND status = 'open' RETURNING *`,
      [req.params.id, body.version, req.user!.username, at, body.action, body.note ?? null],
    )
    if (updated.rowCount === 0) {
      const current = await pool.query<AlertRow>(`${SELECT} WHERE a.id = $1`, [req.params.id])
      if (!current.rows[0]) throw notFound('Alert')
      throw new HttpError(409, 'STALE_ALERT', 'The alert changed (escalated or acknowledged by someone else). Review it and try again.', {
        alert: alertDto(current.rows[0]),
      })
    }
    const alert = updated.rows[0]
    await pool.query(`INSERT INTO alert_events (alert_id, kind, tier, note, actor, at) VALUES ($1, 'acknowledged', $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [
      alert.id, alert.tier, `${body.action}${body.note ? `: ${body.note}` : ''}`, req.user!.username, at,
    ])
    await publishEvents([{ type: 'alert.updated', alertId: alert.id, tripId: alert.trip_id, yardId: alert.yard_id, deskId: alert.desk_id }])
    res.json({ alert: alertDto(alert) })
  }),
)
