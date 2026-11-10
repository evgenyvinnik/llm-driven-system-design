/**
 * Endpoint management: create, edit filters, enable/disable, rotate secret,
 * deliveries per endpoint, bulk replay.
 */
import { Router } from 'express'
import { z } from 'zod'
import { orgOf, requireCustomer } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { disableEndpoint, enqueue } from '../../shared/dispatch.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { newId, newSigningSecret } from '../../shared/ids.js'
import { FILTER_PATTERN } from '../../delivery/filter.js'
import { activeSigningSecrets } from '../../delivery/signing.js'
import { toDeliveryDto, type DeliveryRow } from '../services/dto.js'
import { endpointRow, getEndpoint, listEndpoints, vetUrlForRegistration } from '../services/endpoints.js'

export const endpointsRouter = Router()
endpointsRouter.use('/endpoints', requireCustomer)

const eventTypes = z.array(z.string().regex(FILTER_PATTERN, 'Use *, a family such as order.* or an exact type')).min(1).max(50)

const createSchema = z
  .object({
    url: z.string().min(1).max(2000),
    description: z.string().max(200).default(''),
    eventTypes: eventTypes.default(['*']),
    maxConcurrency: z.number().int().min(1).max(32).default(config.delivery.defaultConcurrency),
  })
  .strict()

const patchSchema = z
  .object({ url: z.string().min(1).max(2000), description: z.string().max(200), eventTypes, maxConcurrency: z.number().int().min(1).max(32) })
  .partial()
  .strict()

endpointsRouter.get(
  '/endpoints',
  asyncHandler(async (req, res) => {
    res.json({ endpoints: await listEndpoints(orgOf(req)) })
  }),
)

endpointsRouter.post(
  '/endpoints',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body)
    const { warning } = await vetUrlForRegistration(input.url)
    const id = newId.endpoint()
    const secret = newSigningSecret()
    await pool.query(
      `INSERT INTO endpoints (id, org_id, url, description, event_types, max_concurrency, secret_current) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, orgOf(req), input.url, input.description, input.eventTypes, input.maxConcurrency, secret],
    )
    res.status(201).json({ endpoint: await getEndpoint(orgOf(req), id), secret, warning })
  }),
)

endpointsRouter.get(
  '/endpoints/:id',
  asyncHandler(async (req, res) => {
    res.json({ endpoint: await getEndpoint(orgOf(req), req.params.id) })
  }),
)

endpointsRouter.patch(
  '/endpoints/:id',
  asyncHandler(async (req, res) => {
    const patch = patchSchema.parse(req.body)
    const row = await endpointRow(orgOf(req), req.params.id)
    let warning: string | null = null
    if (patch.url !== undefined && patch.url !== row.url) warning = (await vetUrlForRegistration(patch.url)).warning
    await pool.query(
      `UPDATE endpoints SET url = COALESCE($3, url), description = COALESCE($4, description), event_types = COALESCE($5, event_types),
              max_concurrency = COALESCE($6, max_concurrency), updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [row.id, row.org_id, patch.url ?? null, patch.description ?? null, patch.eventTypes ?? null, patch.maxConcurrency ?? null],
    )
    res.json({ endpoint: await getEndpoint(row.org_id, row.id), warning })
  }),
)

endpointsRouter.post(
  '/endpoints/:id/enable',
  asyncHandler(async (req, res) => {
    const row = await endpointRow(orgOf(req), req.params.id)
    await pool.query(
      `UPDATE endpoints SET status = 'active', disabled_reason = NULL, disabled_at = NULL, consecutive_failures = 0,
              failing_since = NULL, paused_until = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    )
    res.json({ endpoint: await getEndpoint(row.org_id, row.id) })
  }),
)

endpointsRouter.post(
  '/endpoints/:id/disable',
  asyncHandler(async (req, res) => {
    const row = await endpointRow(orgOf(req), req.params.id)
    await withTransaction((client) => disableEndpoint(client, row.id, 'manual', 'Disabled from the console.'))
    res.json({ endpoint: await getEndpoint(row.org_id, row.id) })
  }),
)

const rotateSchema = z.object({ overlapSeconds: z.number().int().min(0).max(7 * 24 * 3600).optional() }).strict()

/**
 * Rotation: the new secret becomes current; the old one keeps being sent next
 * to it until the overlap ends, so the receiver can switch whenever it deploys.
 */
endpointsRouter.post(
  '/endpoints/:id/rotate-secret',
  asyncHandler(async (req, res) => {
    const { overlapSeconds = config.signing.defaultOverlapSeconds } = rotateSchema.parse(req.body ?? {})
    const row = await endpointRow(orgOf(req), req.params.id)
    const secret = newSigningSecret()
    const { rows } = await pool.query<{ previous_expires_at: Date }>(
      `UPDATE endpoints SET secret_previous = secret_current, secret_current = $2,
              previous_expires_at = now() + make_interval(secs => $3), secret_rotated_at = now(), updated_at = now()
        WHERE id = $1 RETURNING previous_expires_at`,
      [row.id, secret, overlapSeconds],
    )
    res.json({ secret, previousExpiresAt: rows[0].previous_expires_at.toISOString(), overlapSeconds })
  }),
)

endpointsRouter.get(
  '/endpoints/:id/secret',
  asyncHandler(async (req, res) => {
    const row = await endpointRow(orgOf(req), req.params.id)
    const active = activeSigningSecrets({ secretCurrent: row.secret_current, secretPrevious: row.secret_previous, previousExpiresAt: row.previous_expires_at })
    res.json({
      current: row.secret_current,
      previous: active.length > 1 ? row.secret_previous : null,
      previousExpiresAt: active.length > 1 && row.previous_expires_at ? row.previous_expires_at.toISOString() : null,
    })
  }),
)

const deliveriesQuery = z.object({
  state: z.enum(['queued', 'in_flight', 'scheduled', 'delivered', 'failed', 'pending']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

endpointsRouter.get(
  '/endpoints/:id/deliveries',
  asyncHandler(async (req, res) => {
    const q = deliveriesQuery.parse(req.query)
    const row = await endpointRow(orgOf(req), req.params.id)
    const states = q.state === 'pending' ? ['queued', 'in_flight', 'scheduled'] : q.state ? [q.state] : null
    const { rows } = await pool.query<DeliveryRow & { event_type: string; ordering_key: string | null; sequence: string | null }>(
      `SELECT d.*, ev.type AS event_type, ev.ordering_key, ev.sequence
         FROM deliveries d JOIN events ev ON ev.id = d.event_id
        WHERE d.endpoint_id = $1 AND ($2::text[] IS NULL OR d.state = ANY($2))
        ORDER BY d.id DESC LIMIT $3`,
      [row.id, states, q.limit],
    )
    res.json({ deliveries: rows.map(toDeliveryDto) })
  }),
)

const replaySchema = z.object({ since: z.string().datetime({ offset: true }) }).strict()

/** "Replay all failed since T": new attempts for the same event ids, never new events. */
endpointsRouter.post(
  '/endpoints/:id/replay',
  asyncHandler(async (req, res) => {
    const { since } = replaySchema.parse(req.body)
    const row = await endpointRow(orgOf(req), req.params.id)
    if (row.status !== 'active') throw new HttpError(409, 'ENDPOINT_DISABLED', 'Re-enable the endpoint before replaying to it')
    const moved = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM deliveries WHERE endpoint_id = $1 AND state = 'failed' AND created_at >= $2 ORDER BY id LIMIT 10000 FOR UPDATE SKIP LOCKED`,
        [row.id, since],
      )
      return enqueue(
        client,
        rows.map((r) => r.id),
        ['failed'],
        { replay: true },
      )
    })
    res.json({ replayed: moved.length })
  }),
)
