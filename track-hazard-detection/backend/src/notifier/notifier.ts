/**
 * Simulated notifier: the dispatcher console, pagers, train radio bulletins
 * and the inspector's phone.
 *
 * The handler only records what must be sent (one notifications row per
 * channel and recipient, keyed `event id:channel:recipient`) in the same
 * transaction as its processed-events mark, then acks. Delivery runs after
 * commit, asynchronously, so a slow radio bulletin never holds up the next
 * critical alert. Rows left 'sending' by a crash are retried by a sweeper:
 * at-least-once toward the provider, deduplicated by the idempotency key.
 * Train warnings go out in ETA order, nearest train first.
 * @module notifier/notifier
 */
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import type { Envelope } from '../shared/events/envelope.js'
import type { DomainPayload } from '../shared/events/domain.js'
import type { HandlerOutcome } from '../shared/consumer.js'
import { markProcessed } from '../shared/idempotency.js'
import { publishLive } from '../shared/live.js'
import { logger } from '../shared/logger.js'
import { detectionToAlert, notifications } from '../shared/metrics.js'

export const CONSUMER = 'notifier'

export type Channel = 'console' | 'pager' | 'radio' | 'phone'

export interface Planned {
  channel: Channel
  recipient: string
  message: string
  /** Deliveries in a group go out one after another (train warnings in ETA order). */
  order: number
}

/** What to send for a domain event. Pure. */
export function plan(env: Envelope): Planned[] {
  const p = env.payload as Record<string, unknown>
  switch (env.type) {
    case 'AlertIssued': {
      const d = p as unknown as DomainPayload<'AlertIssued'>
      const who = d.assignee ?? `${d.deskId} desk`
      const out: Planned[] = [{ channel: 'console', recipient: who, message: `${d.severity} ${d.summary}`, order: 0 }]
      if (d.severity === 'CRITICAL' || d.severity === 'HIGH') out.push({ channel: 'pager', recipient: who, message: `${d.severity}: ${d.summary}`, order: 0 })
      return out
    }
    case 'AlertEscalated': {
      const d = p as unknown as DomainPayload<'AlertEscalated'>
      const msg = d.reason === 'ack_overdue' ? `Unacknowledged ${d.severity} alert ${d.alertId} escalated to you (level ${d.level})` : `${d.alertId} raised to ${d.severity}; acknowledge again`
      return [
        { channel: 'pager', recipient: d.target, message: msg, order: 0 },
        { channel: 'console', recipient: d.target, message: msg, order: 0 },
      ]
    }
    case 'TrainsWarned': {
      const d = p as unknown as DomainPayload<'TrainsWarned'>
      return d.trains.map((t, i) => ({ channel: 'radio' as const, recipient: t.symbol, message: `${t.symbol}: ${d.instruction} (ETA ${t.etaMinutes} min)`, order: i }))
    }
    case 'TrainsReleased': {
      const d = p as unknown as DomainPayload<'TrainsReleased'>
      return d.trainIds.map((t, i) => ({ channel: 'radio' as const, recipient: t, message: `${t}: released, ${d.reason}`, order: i }))
    }
    case 'InspectorDispatched': {
      const d = p as unknown as DomainPayload<'InspectorDispatched'>
      return [{ channel: 'phone', recipient: d.inspector, message: `Dispatched to hazard ${d.hazardId.slice(0, 8)}${d.note ? `: ${d.note}` : ''}`, order: 0 }]
    }
    default:
      return []
  }
}

const LATENCY_MS: Record<Channel, [number, number]> = { console: [20, 120], pager: [250, 700], radio: [300, 900], phone: [400, 1200] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One simulated provider call. */
async function send(channel: Channel): Promise<boolean> {
  const [lo, hi] = LATENCY_MS[channel]
  await sleep(lo + Math.random() * (hi - lo))
  return Math.random() >= config.notifier.failureRate
}

interface Row {
  id: number
  channel: Channel
  recipient: string
  attempts: number
  event_type: string
  status: string
}

async function deliver(row: Row, env: Envelope | null): Promise<void> {
  let attempts = row.attempts
  while (attempts < config.notifier.maxAttempts) {
    attempts += 1
    const ok = await send(row.channel)
    notifications.inc({ channel: row.channel, outcome: ok ? 'delivered' : 'failed_attempt' })
    if (ok) {
      const { rows } = await pool.query<{ delivered_at: Date }>(
        `UPDATE notifications SET status = 'delivered', attempts = $2, delivered_at = clock_timestamp() WHERE id = $1 AND status <> 'delivered' RETURNING delivered_at`,
        [row.id, attempts],
      )
      if (rows[0] && env?.type === 'AlertIssued' && row.channel === 'console') await recordAlertLatency(env, new Date(rows[0].delivered_at))
      return
    }
    await pool.query('UPDATE notifications SET attempts = $2 WHERE id = $1', [row.id, attempts])
    await sleep(150 * 2 ** attempts)
  }
  await pool.query(`UPDATE notifications SET status = 'failed' WHERE id = $1`, [row.id])
  logger.error({ id: row.id, channel: row.channel, recipient: row.recipient }, 'notification failed after retries')
}

async function recordAlertLatency(env: Envelope, deliveredAt: Date): Promise<void> {
  const d = env.payload as DomainPayload<'AlertIssued'>
  const totalMs = deliveredAt.getTime() - Date.parse(d.timing.edgeOccurredAt)
  detectionToAlert.observe({ lane: d.lane, late: String(d.late) }, totalMs / 1000)
  await pool.query(
    `INSERT INTO latency_samples (kind, hazard_id, event_id, event_type, lane, late, edge_occurred_at, ingested_at, detected_at, alert_issued_at, delivered_at, total_ms)
     VALUES ('alert', $1, $2, 'AlertIssued', $3, $4, $5, $6, $7, $8, $9, $10)`,
    [d.hazardId, env.eventId, d.lane, d.late, d.timing.edgeOccurredAt, d.timing.ingestedAt, d.timing.detectedAt, env.recordedAt, deliveredAt, totalMs],
  )
  await publishLive([{ topics: ['latency'] }])
}

/** Records the planned notifications (idempotently) and starts delivery after commit. */
export async function handleDomainEvent(env: Envelope): Promise<HandlerOutcome> {
  const planned = plan(env)
  const hazardId = env.streamId.startsWith('hazard-') ? env.streamId.slice(7) : null
  const rows = await withTransaction(async (client) => {
    if (!(await markProcessed(client, CONSUMER, env.eventId))) return null
    const out: Array<Row & { order: number }> = []
    for (const p of planned) {
      const { rows } = await client.query<Row>(
        `INSERT INTO notifications (idempotency_key, event_id, event_type, hazard_id, channel, recipient, status, message)
         VALUES ($1, $2, $3, $4, $5, $6, 'sending', $7) ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, channel, recipient, attempts, event_type, status`,
        [`${env.eventId}:${p.channel}:${p.recipient}`, env.eventId, env.type, hazardId, p.channel, p.recipient, p.message],
      )
      if (rows[0]) out.push({ ...rows[0], order: p.order })
    }
    return out
  })
  if (rows === null) return 'duplicate'
  if (rows.length === 0) return 'skipped'
  // Same-order deliveries in parallel; ordered groups (train warnings) one after another, nearest first.
  const groups = new Map<number, Row[]>()
  for (const r of rows) groups.set(r.order, [...(groups.get(r.order) ?? []), r])
  void (async () => {
    for (const order of [...groups.keys()].sort((a, b) => a - b)) await Promise.all(groups.get(order)!.map((r) => deliver(r, env)))
    await publishLive([{ topics: ['hazards'], hazardId: hazardId ?? undefined }])
  })().catch((err) => logger.error({ err: (err as Error).message }, 'delivery failed'))
  return 'ok'
}

/** Retries deliveries a crashed notifier left in 'sending'. */
export async function sweepStuck(): Promise<number> {
  const { rows } = await pool.query<Row & { event_id: string }>(
    `SELECT id, channel, recipient, attempts, event_type, status, event_id FROM notifications
     WHERE status = 'sending' AND created_at < now() - interval '20 seconds' AND attempts < $1 ORDER BY id LIMIT 20`,
    [config.notifier.maxAttempts],
  )
  for (const r of rows) await deliver(r, null)
  return rows.length
}
