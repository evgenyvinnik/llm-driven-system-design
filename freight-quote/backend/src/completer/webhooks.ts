/**
 * Signed customer callbacks, delivered at least once.
 *
 * The `webhooks` consumer turns FirmQuoteCompleted into a delivery row
 * (UNIQUE event_id, so a redelivered event creates nothing new). A dispatcher
 * loop claims due rows with SKIP LOCKED and a lease (locked_until), POSTs the
 * signed payload, and on failure schedules a retry with exponential backoff
 * and jitter. After maxAttempts the delivery is `dead` and can be retried by
 * an operator. The HTTP call happens outside any transaction, so a crash
 * after the POST and before the status update means the customer gets it
 * twice. They deduplicate by X-FQ-Event-Id.
 * @module completer/webhooks
 */
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import type { DomainEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { webhookDeliveries } from '../shared/metrics.js'
import { signPayload } from '../shared/signing.js'

export async function enqueueFirmCallback(event: DomainEvent<'FirmQuoteCompleted'>): Promise<'queued' | 'duplicate' | 'no_callback'> {
  const { rows } = await pool.query(
    `SELECT q.callback, q.origin, q.destination, q.commodity, q.equipment, q.quantity, q.inputs, c.webhook_url
     FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.id = $1`,
    [event.payload.quote_id],
  )
  const q = rows[0]
  if (!q || !q.callback || !q.webhook_url) return 'no_callback'
  const payload = {
    event_id: event.event_id,
    type: 'quote.firm_completed',
    occurred_at: event.occurred_at,
    quote: {
      id: event.payload.quote_id,
      kind: 'firm',
      lane: `${q.origin}-${q.destination}`,
      commodity: q.commodity,
      equipment: q.equipment,
      quantity: q.quantity,
      total_cents: event.payload.total_cents,
      indicative_total_cents: event.payload.indicative_total_cents,
      valid_until: event.payload.valid_until,
      inputs: q.inputs,
    },
  }
  const res = await pool.query(
    `INSERT INTO webhook_deliveries (event_id, quote_id, customer_id, url, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING`,
    [event.event_id, event.payload.quote_id, event.payload.customer_id, q.webhook_url, JSON.stringify(payload)],
  )
  return (res.rowCount ?? 0) > 0 ? 'queued' : 'duplicate'
}

export function nextBackoffMs(attempts: number, baseMs = config.webhooks.baseBackoffMs, rand = Math.random): number {
  const exp = Math.min(60_000, baseMs * 2 ** Math.max(0, attempts - 1))
  return Math.round(exp / 2 + rand() * (exp / 2))
}

/** Claims and delivers due callbacks. Returns how many were attempted. */
export async function dispatchDue(limit = 10): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries d SET status = 'in_flight', locked_until = now() + interval '30 seconds', attempts = d.attempts + 1
     FROM (SELECT id FROM webhook_deliveries
           WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'in_flight' AND locked_until < now())
           ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED) due
     WHERE d.id = due.id
     RETURNING d.*, (SELECT webhook_secret FROM customers c WHERE c.id = d.customer_id) AS secret`,
    [limit],
  )
  await Promise.all(rows.map((row) => deliver(row)))
  return rows.length
}

async function deliver(row: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(row.payload)
  const ts = Math.floor(Date.now() / 1000)
  const attempts = row.attempts as number
  let status: number | null = null
  let error: string | null = null
  try {
    const res = await fetch(row.url as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fq-event-id': row.event_id as string,
        'x-fq-delivery-id': row.id as string,
        'x-fq-delivery-attempt': String(attempts),
        'x-fq-signature': signPayload(row.secret as string, body, ts),
      },
      body,
      signal: AbortSignal.timeout(config.webhooks.timeoutMs),
    })
    status = res.status
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = (err as Error).message
  }
  if (!error) {
    await pool.query(`UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_status_code = $2, last_error = NULL, locked_until = NULL WHERE id = $1`, [row.id, status])
    webhookDeliveries.inc({ result: 'delivered' })
    return
  }
  const dead = attempts >= config.webhooks.maxAttempts
  await pool.query(
    `UPDATE webhook_deliveries SET status = $2, last_status_code = $3, last_error = $4, locked_until = NULL,
       next_attempt_at = now() + ($5::int * interval '1 millisecond') WHERE id = $1`,
    [row.id, dead ? 'dead' : 'pending', status, error, nextBackoffMs(attempts)],
  )
  webhookDeliveries.inc({ result: dead ? 'dead' : 'failed_attempt' })
  logger.warn({ delivery: row.id, attempts, error, dead }, 'webhook delivery failed')
}
