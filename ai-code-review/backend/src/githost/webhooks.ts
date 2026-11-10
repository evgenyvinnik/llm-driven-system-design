/**
 * Webhook sender. Deliveries come from an outbox written with each change, so
 * none is lost to a crash. They go out signed, one at a time in order, and are
 * retried with backoff under a stable delivery id.
 *
 * The armed counts exist so the fixture panel and the e2e can make delivery
 * misbehave on demand: drop (lost webhook), duplicate (at-least-once redelivery).
 * @module githost/webhooks
 */
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { signPayload } from '../shared/webhook-signature.js'

export const webhookControls = {
  dropNext: 0,
  duplicateNext: 0,
  /** Holds each incoming review before it takes the row lock, simulating latency between re-check and write. */
  reviewDelayMs: 0,
}

export interface DeliveryRow {
  id: string
  event: string
  action: string
  payload: unknown
  attempts: number
}

const secret = () => process.env.WEBHOOK_SECRET || 'dev-webhook-secret'

export function buildRequest(row: DeliveryRow, now = Date.now()) {
  const body = JSON.stringify(row.payload)
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Hook-Event': row.event,
      'X-Hook-Delivery': row.id,
      'X-Hook-Signature': signPayload(secret(), Math.floor(now / 1000), body),
    },
  }
}

export async function send(url: string, row: DeliveryRow): Promise<{ status: number; body: unknown }> {
  const req = buildRequest(row)
  const res = await fetch(url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(5000) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export function startWebhookSender(urls: string[]): () => void {
  let stopped = false
  let next = 0
  async function tick(): Promise<boolean> {
    const res = await pool.query<DeliveryRow>(
      `SELECT id, event, action, payload, attempts FROM githost.deliveries
       WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY seq LIMIT 1`,
    )
    const row = res.rows[0]
    if (!row) return false
    if (webhookControls.dropNext > 0) {
      webhookControls.dropNext--
      await pool.query(`UPDATE githost.deliveries SET status = 'dropped', last_error = 'dropped by fixture switch' WHERE id = $1`, [row.id])
      logger.info({ id: row.id, event: row.event }, 'webhook dropped on purpose')
      return true
    }
    const url = urls[next++ % urls.length]
    try {
      const result = await send(url, row)
      if (webhookControls.duplicateNext > 0) {
        webhookControls.duplicateNext--
        await send(url, row)
      }
      if (result.status >= 200 && result.status < 300) {
        await pool.query(`UPDATE githost.deliveries SET status = 'delivered', delivered_at = now(), attempts = attempts + 1, last_status = $2 WHERE id = $1`, [row.id, result.status])
      } else {
        throw new Error(`receiver returned ${result.status}`)
      }
    } catch (err) {
      const attempts = row.attempts + 1
      const failed = attempts >= 8
      await pool.query(
        `UPDATE githost.deliveries SET attempts = $2, last_error = $3, status = $4, next_attempt_at = now() + ($5 || ' milliseconds')::interval WHERE id = $1`,
        [row.id, attempts, (err as Error).message, failed ? 'failed' : 'pending', String(Math.min(250 * 2 ** attempts, 8000))],
      )
      if (!failed) return false
    }
    return true
  }
  void (async () => {
    while (!stopped) {
      const worked = await tick().catch((err) => {
        logger.warn({ err: (err as Error).message }, 'webhook tick failed')
        return false
      })
      if (!worked) await new Promise((r) => setTimeout(r, 100))
    }
  })()
  return () => {
    stopped = true
  }
}
