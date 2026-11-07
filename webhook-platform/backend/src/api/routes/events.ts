/**
 * Event intake (producers) and the event log (console).
 */
import { Router } from 'express'
import { z } from 'zod'
import { orgOf, requireCustomer, requireProducer } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { EVENT_TYPE_PATTERN } from '../../delivery/filter.js'
import { emitEvent, emitSchema } from '../services/emit.js'
import { toDeliveryDto, toEventDto, type DeliveryRow, type EventRow } from '../services/dto.js'

export const eventsRouter = Router()

eventsRouter.post(
  '/events',
  asyncHandler(requireProducer),
  asyncHandler(async (req, res) => {
    const key = req.get('idempotency-key')?.trim()
    if (!key || key.length > 200) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (1-200 characters) so a retried emit cannot create a second event')
    const input = emitSchema.parse(req.body)
    const principal = req.principal!
    const result = await emitEvent(principal.orgId, key, input, principal.via === 'session' ? 'console' : 'api')
    if (result.replayed) res.set('Idempotent-Replayed', 'true')
    res.status(result.replayed ? 200 : 201).json(result)
  }),
)

const listQuery = z.object({
  type: z.string().regex(EVENT_TYPE_PATTERN).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

eventsRouter.get(
  '/events',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query)
    const { rows } = await pool.query<EventRow & { total: number; delivered: number; failed: number; pending: number }>(
      `SELECT ev.*,
              count(d.id)::int AS total,
              count(d.id) FILTER (WHERE d.state = 'delivered')::int AS delivered,
              count(d.id) FILTER (WHERE d.state = 'failed')::int AS failed,
              count(d.id) FILTER (WHERE d.state IN ('queued', 'in_flight', 'scheduled'))::int AS pending
         FROM events ev LEFT JOIN deliveries d ON d.event_id = ev.id
        WHERE ev.org_id = $1 AND ($2::text IS NULL OR ev.type = $2) AND ($3::text IS NULL OR ev.id < $3)
        GROUP BY ev.id ORDER BY ev.id DESC LIMIT $4`,
      [orgOf(req), q.type ?? null, q.before ?? null, q.limit],
    )
    res.json({
      events: rows.map((r) => ({ ...toEventDto(r), deliveries: { total: r.total, delivered: r.delivered, failed: r.failed, pending: r.pending } })),
    })
  }),
)

eventsRouter.get(
  '/events/:id',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const orgId = orgOf(req)
    const ev = await pool.query<EventRow>('SELECT * FROM events WHERE id = $1 AND org_id = $2', [req.params.id, orgId])
    if (!ev.rows[0]) throw notFound('Event')
    const deliveries = await pool.query<DeliveryRow & { endpoint_url: string; endpoint_description: string }>(
      `SELECT d.*, e.url AS endpoint_url, e.description AS endpoint_description
         FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id WHERE d.event_id = $1 AND d.org_id = $2 ORDER BY e.created_at`,
      [req.params.id, orgId],
    )
    res.json({ event: toEventDto(ev.rows[0]), deliveries: deliveries.rows.map(toDeliveryDto) })
  }),
)
