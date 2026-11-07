import { randomUUID } from 'node:crypto'
import { Router, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { actingCustomer, canSeeCustomer, isStaff, requireAuth } from '../../shared/auth.js'
import { readStream, rowToEnvelope } from '../../shared/event-store.js'
import { quoteStream } from '../../shared/events.js'
import { loadQuote, toView, type QuoteResponse, type QuoteService } from '../services/quotes.js'

function send(res: Response, r: QuoteResponse): void {
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
  res.status(r.status).json(r.body)
}

function idempotencyKey(header: string | undefined): string {
  if (!header || header.length < 8 || header.length > 128) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 characters), reused on every retry of the same request')
  }
  return header
}

export function quotesRouter(service: QuoteService): Router {
  const router = Router()
  router.use(requireAuth)

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const customerId = actingCustomer(req)
      if (!customerId) throw new HttpError(403, 'CUSTOMER_ONLY', 'Quotes are requested by a customer user or an API key')
      const deadlineHeader = req.get('x-request-deadline-ms')
      const result = await service.submit({
        customerId,
        baseClass: req.apiClient ? 'api' : 'portal',
        idempotencyKey: idempotencyKey(req.get('idempotency-key')),
        body: req.body,
        requestedDeadlineMs: deadlineHeader ? Math.max(50, Number(deadlineHeader)) : null,
        correlationId: req.get('x-correlation-id') || `corr-${randomUUID().slice(0, 12)}`,
      })
      send(res, result)
    }),
  )

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, status } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), status: z.string().optional() }).parse(req.query)
      const customerId = actingCustomer(req)
      if (!customerId && !isStaff(req)) throw new HttpError(403, 'FORBIDDEN', 'No customer')
      const params: unknown[] = [limit]
      const where: string[] = []
      if (customerId) where.push(`q.customer_id = $${params.push(customerId)}`)
      if (status) where.push(`q.status = $${params.push(status)}`)
      const { rows } = await pool.query(
        `SELECT q.*, c.name AS customer_name, row_to_json(b) AS booking FROM quotes q JOIN customers c ON c.id = q.customer_id
         LEFT JOIN bookings b ON b.quote_id = q.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.created_at DESC LIMIT $1`,
        params,
      )
      res.json({ quotes: rows.map((r) => toView(r, r.booking, r.customer_name)) })
    }),
  )

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id)
      const found = await loadQuote(pool, id)
      // Another customer's quote is reported as missing, not forbidden, so ids can't be probed.
      if (!found || !canSeeCustomer(req, found.row.customer_id as string)) throw notFound('Quote')
      res.json({ quote: toView(found.row, found.booking, found.customerName) })
    }),
  )

  router.get(
    '/:id/events',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id)
      const found = await loadQuote(pool, id)
      if (!found || !canSeeCustomer(req, found.row.customer_id as string)) throw notFound('Quote')
      const events = await readStream(pool, quoteStream(id))
      // Causes outside the quote's own stream (a TariffPublished that re-priced it).
      const ownIds = new Set(events.map((e) => e.event_id))
      const external = [...new Set(events.map((e) => e.causation_id).filter((c): c is string => !!c && !ownIds.has(c)))]
      const { rows } = external.length ? await pool.query('SELECT * FROM events WHERE event_id = ANY($1::uuid[])', [external]) : { rows: [] }
      const deliveries = await pool.query('SELECT id, event_id, status, attempts, last_status_code, last_error, created_at, delivered_at FROM webhook_deliveries WHERE quote_id = $1', [id])
      res.json({ events, causes: rows.map(rowToEnvelope), deliveries: deliveries.rows })
    }),
  )

  router.post(
    '/:id/book',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id)
      const result = await service.book(id, actingCustomer(req), isStaff(req), idempotencyKey(req.get('idempotency-key')))
      send(res, result)
    }),
  )

  return router
}
