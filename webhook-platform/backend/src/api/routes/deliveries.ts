/**
 * Delivery detail (every attempt) and single-delivery replay.
 */
import { Router } from 'express'
import { orgOf, requireCustomer } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { enqueue } from '../../shared/dispatch.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { toAttemptDto, toDeliveryDto, toEventDto, type AttemptRow, type DeliveryRow, type EventRow } from '../services/dto.js'

export const deliveriesRouter = Router()
deliveriesRouter.use('/deliveries', requireCustomer)

async function deliveryFor(orgId: string, id: string) {
  const { rows } = await pool.query<DeliveryRow & { endpoint_url: string; endpoint_description: string; endpoint_status: string }>(
    `SELECT d.*, e.url AS endpoint_url, e.description AS endpoint_description, e.status AS endpoint_status
       FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id WHERE d.id = $1 AND d.org_id = $2`,
    [id, orgId],
  )
  if (!rows[0]) throw notFound('Delivery')
  return rows[0]
}

deliveriesRouter.get(
  '/deliveries/:id',
  asyncHandler(async (req, res) => {
    const d = await deliveryFor(orgOf(req), req.params.id)
    const [ev, attempts] = await Promise.all([
      pool.query<EventRow>('SELECT * FROM events WHERE id = $1', [d.event_id]),
      pool.query<AttemptRow>('SELECT * FROM attempts WHERE delivery_id = $1 ORDER BY id', [d.id]),
    ])
    res.json({
      delivery: { ...toDeliveryDto(d), endpointStatus: d.endpoint_status },
      event: toEventDto(ev.rows[0]),
      attempts: attempts.rows.map(toAttemptDto),
    })
  }),
)

/**
 * Replay = a new attempt for the SAME event id (the receiver's dedupe still
 * recognises it), with a fresh retry window. It is not a new event.
 */
deliveriesRouter.post(
  '/deliveries/:id/replay',
  asyncHandler(async (req, res) => {
    const d = await deliveryFor(orgOf(req), req.params.id)
    if (d.endpoint_status !== 'active') throw new HttpError(409, 'ENDPOINT_DISABLED', 'Re-enable the endpoint before replaying to it')
    if (d.state !== 'failed' && d.state !== 'delivered') throw new HttpError(409, 'DELIVERY_PENDING', `This delivery is ${d.state}; it will be attempted without a replay`)
    const moved = await withTransaction((client) => enqueue(client, [d.id], ['failed', 'delivered'], { replay: true }))
    if (moved.length === 0) throw new HttpError(409, 'DELIVERY_PENDING', 'The delivery changed state; refresh and try again')
    res.status(202).json({ deliveryId: d.id, eventId: d.event_id, state: 'queued' })
  }),
)
