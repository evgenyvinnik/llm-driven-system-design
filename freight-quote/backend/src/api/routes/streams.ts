import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { requireRole } from '../../shared/auth.js'
import { streamHealth } from '../../shared/monitor.js'
import { discardDeadLetter, listDeadLetters, partitionKey, redriveDeadLetter, xaddEvent } from '../../shared/stream.js'
import { verifyAnalytics, rebuildAnalytics } from '../../projector/rebuild.js'

/** Streams, consumer groups, the dead-letter queue, webhook deliveries and projection replay (ops). */
export function streamsRouter(redis: Redis): Router {
  const router = Router()
  router.use(requireRole('ops'))

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const health = await streamHealth(redis, pool)
      const deliveries = await pool.query<{ status: string; n: number }>('SELECT status, COUNT(*)::int AS n FROM webhook_deliveries GROUP BY status')
      res.json({ ...health, webhooks: Object.fromEntries(deliveries.rows.map((r) => [r.status, r.n])) })
    }),
  )

  router.get(
    '/dlq',
    asyncHandler(async (_req, res) => {
      res.json({ deadLetters: await listDeadLetters(redis, 200) })
    }),
  )

  router.post(
    '/dlq/:id/redrive',
    asyncHandler(async (req, res) => {
      const letter = await redriveDeadLetter(redis, req.params.id)
      if (!letter) throw notFound('Dead letter')
      res.json({ redriven: letter, to: `${config.streams.redrivePrefix}${letter.group}` })
    }),
  )

  router.post(
    '/dlq/:id/discard',
    asyncHandler(async (req, res) => {
      if (!(await discardDeadLetter(redis, req.params.id))) throw notFound('Dead letter')
      res.json({ discarded: req.params.id })
    }),
  )

  /** Demo: publish a message no consumer can parse (unknown schema version), to watch it reach the DLQ. */
  router.post(
    '/poison',
    asyncHandler(async (req, res) => {
      const kind = z.object({ kind: z.enum(['unknown_version', 'malformed']).default('unknown_version') }).parse(req.body ?? {}).kind
      const event =
        kind === 'malformed'
          ? '{"this is": not json'
          : JSON.stringify({
              event_id: randomUUID(),
              type: 'QuoteRequested',
              version: 9,
              occurred_at: new Date().toISOString(),
              recorded_at: new Date().toISOString(),
              stream_id: `quote-${randomUUID()}`,
              stream_version: 1,
              correlation_id: 'poison-demo',
              causation_id: null,
              producer: 'ops-demo',
              payload: { quote_id: 'not-a-uuid' },
            })
      const id = await xaddEvent(redis, partitionKey(0), { event, type: 'QuoteRequested', poison: kind })
      res.status(201).json({ stream: partitionKey(0), id, kind })
    }),
  )

  router.get(
    '/webhooks',
    asyncHandler(async (_req, res) => {
      const { rows } = await pool.query(
        `SELECT d.id, d.event_id, d.quote_id, d.customer_id, c.name AS customer_name, d.url, d.status, d.attempts, d.next_attempt_at, d.last_status_code,
           d.last_error, d.created_at, d.delivered_at
         FROM webhook_deliveries d JOIN customers c ON c.id = d.customer_id ORDER BY d.created_at DESC LIMIT 100`,
      )
      const receiver: unknown = await fetch(`${config.receiverUrl}/inbox`, { signal: AbortSignal.timeout(2_000) })
        .then((r) => r.json())
        .catch(() => null)
      res.json({ deliveries: rows, receiver })
    }),
  )

  router.post(
    '/webhooks/:id/retry',
    asyncHandler(async (req, res) => {
      const { rowCount } = await pool.query(
        `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now(), attempts = 0 WHERE id = $1 AND status IN ('dead', 'pending')`,
        [z.string().uuid().parse(req.params.id)],
      )
      if (!rowCount) throw new HttpError(409, 'NOT_RETRYABLE', 'Only dead or pending deliveries can be retried')
      res.json({ ok: true })
    }),
  )

  router.put(
    '/receiver/knobs',
    asyncHandler(async (req, res) => {
      const r = await fetch(`${config.receiverUrl}/knobs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(2_000) })
      res.status(r.status).json(await r.json())
    }),
  )

  router.post(
    '/projections/analytics/verify',
    asyncHandler(async (_req, res) => {
      res.json(await verifyAnalytics())
    }),
  )

  router.post(
    '/projections/analytics/rebuild',
    requireRole('admin'),
    asyncHandler(async (_req, res) => {
      res.json(await rebuildAnalytics())
    }),
  )

  return router
}
