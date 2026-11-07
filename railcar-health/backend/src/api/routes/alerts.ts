/**
 * Alert queue and alert detail. Dispatchers and reliability engineers see every
 * alert (filtered by territory in the UI); yard inspectors only their yard's.
 * The list reads the alert-queue projection; acknowledging is a command on the
 * case aggregate (domain rule for concurrent updates in domain/case.ts).
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { clockInfo } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { SUBDIVISIONS } from '../../shared/network.js'
import { streamIds } from '../../events/catalog.js'
import { readStream } from '../../events/store.js'
import { alertDto, caseTimeline, type AlertRow } from '../dto.js'
import { ackSchema, acknowledge } from '../services/commands.js'
import { ALERT_SELECT, getAlertRow } from '../services/queries.js'

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
    const sql = `${ALERT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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
    const alert = await getAlertRow(req.params.id)
    if (!alert) throw notFound('Alert')
    if (req.user!.role === 'yard' && alert.yardId !== req.user!.yardId) throw notFound('Alert')
    // The audit trail is the case's own event stream.
    const [events, notifications] = await Promise.all([
      readStream(pool, streamIds.case(alert.id)),
      pool.query('SELECT channel, target, kind, message, created_at, delivered_at FROM notifications WHERE alert_id = $1 ORDER BY created_at, id', [alert.id]),
    ])
    res.json({
      alert,
      events: caseTimeline(events),
      notifications: notifications.rows.map((n) => ({ channel: n.channel, target: n.target, kind: n.kind, message: n.message, createdAt: n.created_at, deliveredAt: n.delivered_at })),
      clock: clockInfo(),
    })
  }),
)

alertsRouter.post(
  '/:id/acknowledge',
  requireRole('dispatcher', 'yard'),
  asyncHandler(async (req, res) => {
    const body = ackSchema.parse(req.body)
    const { state, rebasedOver } = await acknowledge(req.params.id, body, req.user!)
    // The projection may not have applied the event yet: answer from the aggregate.
    const row = await getAlertRow(state.caseId)
    res.json({
      alert: row && {
        ...row, status: state.status, version: state.version, tier: state.tier, ownerRole: state.owner?.role ?? null, ownerId: state.owner?.id ?? null,
        acknowledgedBy: state.acknowledgedBy, acknowledgedAt: state.acknowledgedAt, ackAction: body.action, ackNote: body.note ?? null,
      },
      rebasedOver,
    })
  }),
)
