/**
 * Wiring for the hazard-response process manager: load and fold the hazard
 * stream under an advisory lock, reconcile, append the decisions with
 * optimistic concurrency, and keep exactly one durable ack-deadline timer per
 * unacknowledged alert. All in one transaction with the processed-events mark.
 * @module alerting/handler
 */
import { config } from '../shared/config.js'
import { lockKey, withTransaction, type Client } from '../shared/db.js'
import { appendToStream, loadStream, withConcurrencyRetry } from '../shared/event-store.js'
import type { Envelope } from '../shared/events/envelope.js'
import { foldHazard } from '../shared/hazard.js'
import type { HandlerOutcome } from '../shared/consumer.js'
import { markProcessed } from '../shared/idempotency.js'
import { escalations } from '../shared/metrics.js'
import type { TrainFix } from '../correlator/rules.js'
import { desiredTimer, reconcile } from './reconcile.js'

export const CONSUMER = 'alerting'

interface TrainRow {
  train_id: string
  symbol: string
  milepost: number
  direction: TrainFix['direction']
  speed_mph: number
  occurred_at: Date
}

async function trainsOn(client: Client, subdivisionId: string): Promise<TrainFix[]> {
  const { rows } = await client.query<TrainRow>(
    `SELECT DISTINCT ON (train_id) train_id, symbol, milepost, direction, speed_mph, occurred_at FROM train_positions
     WHERE subdivision_id = $1 AND occurred_at > now() - interval '10 minutes' ORDER BY train_id, occurred_at DESC`,
    [subdivisionId],
  )
  return rows.map((r) => ({ trainId: r.train_id, symbol: r.symbol, milepost: Number(r.milepost), direction: r.direction, speedMph: Number(r.speed_mph), occurredAt: new Date(r.occurred_at).toISOString() }))
}

async function deskFor(client: Client, subdivisionId: string): Promise<{ deskId: string; assignee: string | null }> {
  const { rows } = await client.query<{ desk_id: string; username: string | null }>(
    `SELECT s.desk_id, (SELECT u.username FROM users u WHERE u.role = 'dispatcher' AND u.desk_id = s.desk_id ORDER BY u.username LIMIT 1) AS username
     FROM subdivisions s WHERE s.id = $1`,
    [subdivisionId],
  )
  return { deskId: rows[0]?.desk_id ?? 'UNKNOWN', assignee: rows[0]?.username ?? null }
}

export async function syncTimer(client: Client, hazardId: string, dueAt: string | null): Promise<void> {
  const { rows } = await client.query<{ id: string; due_at: Date }>(`SELECT id, due_at FROM timers WHERE hazard_id = $1 AND kind = 'ack_deadline' AND status = 'pending'`, [hazardId])
  const keep = dueAt ? rows.find((r) => new Date(r.due_at).toISOString() === new Date(dueAt).toISOString()) : undefined
  const cancel = rows.filter((r) => r !== keep).map((r) => r.id)
  if (cancel.length) await client.query(`UPDATE timers SET status = 'cancelled' WHERE id = ANY($1::uuid[])`, [cancel])
  if (dueAt && !keep) await client.query(`INSERT INTO timers (kind, hazard_id, due_at) VALUES ('ack_deadline', $1, $2)`, [hazardId, dueAt])
}

/** Folds, reconciles and appends for one hazard inside the caller's transaction. */
export async function reconcileHazard(client: Client, hazardId: string, cause: { eventId: string | null; correlationId: string | null }): Promise<Envelope[]> {
  const streamId = `hazard-${hazardId}`
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(streamId)])
  const events = await loadStream(client, streamId)
  let state = foldHazard(events)
  if (!state) return []
  const { deskId, assignee } = await deskFor(client, state.subdivisionId)
  const drafts = reconcile(state, { now: new Date(), trains: await trainsOn(client, state.subdivisionId), deskId, assignee, cfg: config.alerting, heat: config.heat })
  let appended: Envelope[] = []
  if (drafts.length) {
    appended = await appendToStream(client, streamId, state.version, drafts, {
      partitionKey: state.segmentId,
      source: CONSUMER,
      correlationId: cause.correlationId ?? events[0]?.correlationId,
      causationId: cause.eventId,
      meta: { actor: CONSUMER, segmentId: state.segmentId, subdivisionId: state.subdivisionId },
    })
    state = foldHazard([...events, ...appended])
    for (const e of appended) if (e.type === 'AlertEscalated') escalations.inc({ reason: String((e.payload as { reason: string }).reason) })
  }
  await syncTimer(client, hazardId, desiredTimer(state, config.alerting.maxEscalationLevel))
  return appended
}

export async function handleDomainEvent(env: Envelope): Promise<{ outcome: HandlerOutcome; appended: Envelope[] }> {
  if (!env.streamId.startsWith('hazard-')) return { outcome: 'skipped', appended: [] }
  return withConcurrencyRetry(() =>
    withTransaction(async (client) => {
      if (!(await markProcessed(client, CONSUMER, env.eventId))) return { outcome: 'duplicate' as const, appended: [] }
      const appended = await reconcileHazard(client, env.streamId.slice('hazard-'.length), { eventId: env.eventId, correlationId: env.correlationId })
      return { outcome: 'ok' as const, appended }
    }),
  )
}

/** A train moved: re-check open CRITICAL hazards on its subdivision for newly approaching trains. */
export async function handleTrainEvent(env: Envelope): Promise<{ outcome: HandlerOutcome; appended: Envelope[] }> {
  const sub = String((env.payload as { subdivisionId?: string }).subdivisionId ?? '')
  return withConcurrencyRetry(() =>
    withTransaction(async (client) => {
      if (!(await markProcessed(client, CONSUMER, env.eventId))) return { outcome: 'duplicate' as const, appended: [] }
      const { rows } = await client.query<{ key: string }>(`SELECT key FROM proj_hazards WHERE open AND severity = 'CRITICAL' AND subdivision_id = $1 ORDER BY key`, [sub])
      const appended: Envelope[] = []
      for (const r of rows) appended.push(...(await reconcileHazard(client, r.key, { eventId: env.eventId, correlationId: null })))
      return { outcome: 'ok' as const, appended }
    }),
  )
}

/** Fires due ack-deadline timers. Durable: a timer that came due while the service was down fires on restart. */
export async function fireDueTimers(): Promise<Envelope[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; hazard_id: string }>(
      `SELECT id, hazard_id FROM timers WHERE status = 'pending' AND due_at <= now() ORDER BY due_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
    )
    const appended: Envelope[] = []
    for (const t of rows) {
      await client.query(`UPDATE timers SET status = 'fired', fired_at = now() WHERE id = $1`, [t.id])
      appended.push(...(await reconcileHazard(client, t.hazard_id, { eventId: null, correlationId: null })))
    }
    return appended
  })
}
