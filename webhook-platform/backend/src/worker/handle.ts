/**
 * One queue ticket → at most one HTTP attempt.
 *
 * 1. **Claim** the delivery in PostgreSQL with a conditional update: it must
 *    still be `queued` with the ticket's dispatch number. Stale tickets (the
 *    delivery was re-dispatched, replayed or already finished) and duplicate
 *    tickets (the outbox republished after a publisher crash) match nothing
 *    and are dropped. A ticket RabbitMQ *redelivered* may take over an
 *    `in_flight` delivery: redelivery means the previous consumer's channel is
 *    gone, so its worker died or lost the broker. A fresh lease token fences
 *    out that worker if it is in fact still alive.
 * 2. **Gate** on the endpoint: disabled → fail; paused by a 429 → park until
 *    the pause ends; per-endpoint concurrency slot unavailable → park for a
 *    moment. Parking writes `scheduled` + `next_attempt_at` and acks the
 *    ticket, so the worker is free immediately and the wait happens in
 *    PostgreSQL, not in a worker or in the shared queue.
 * 3. **Attempt**: sign, vet and pin the IP, POST, classify.
 * 4. **Record** the attempt and the next state in one transaction, fenced on
 *    the lease token, then ack. If the worker dies before the ack, RabbitMQ
 *    redelivers and the delivery is attempted again: at-least-once. The
 *    receiver dedupes on `Webhook-Id` (the event id).
 * @module worker/handle
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { disableEndpoint } from '../shared/dispatch.js'
import { logger } from '../shared/logger.js'
import { attemptLatency, attemptsTotal, ticketsHandled, workerInFlight } from '../shared/metrics.js'
import { redis } from '../shared/cache.js'
import { acquireSlot, releaseSlot } from '../shared/semaphore.js'
import type { Ticket } from '../shared/queue.js'
import { parseRetryAfter } from '../delivery/backoff.js'
import { classifyStatus, classifyTransportError, decideOutcome, retryWindowDeadline, type Outcome } from '../delivery/classify.js'
import { sendWebhook, type SendResult } from '../delivery/sender.js'
import { activeSigningSecrets, signatureHeader } from '../delivery/signing.js'
import type { DeliveryRow, EndpointRow } from '../api/services/dto.js'

export type TicketResult = 'attempted' | 'stale' | 'busy_parked' | 'paused_parked' | 'endpoint_disabled'

interface ClaimedRow extends DeliveryRow {
  prev_state: string
  /** Worker that held the delivery before this claim (set when taking over from a lost worker). */
  prev_claimed_by: string | null
  prev_updated_at: Date
  /** The database's clock at claim time. */
  db_now: Date
}

interface EventForSend {
  id: string
  type: string
  payload: Record<string, unknown>
  ordering_key: string | null
  sequence: string | null
  created_at: Date
}

async function claim(t: Ticket, redelivered: boolean, leaseToken: string): Promise<ClaimedRow | null> {
  const { rows } = await pool.query<ClaimedRow>(
    `WITH prev AS (SELECT id, state, claimed_by, updated_at FROM deliveries WHERE id = $1 FOR UPDATE)
     UPDATE deliveries d
        SET state = 'in_flight', lease_token = $3, lease_until = now() + make_interval(secs => $4::float8 / 1000),
            claimed_by = $5, updated_at = now()
       FROM prev
      WHERE d.id = prev.id AND d.dispatch_seq = $2
        AND (d.state = 'queued' OR (d.state = 'in_flight' AND ($6::boolean OR d.lease_until < now())))
      RETURNING d.*, prev.state AS prev_state, prev.claimed_by AS prev_claimed_by, prev.updated_at AS prev_updated_at, now() AS db_now`,
    [t.deliveryId, t.dispatchSeq, leaseToken, config.delivery.leaseMs, config.instanceId, redelivered],
  )
  return rows[0] ?? null
}

/**
 * Puts a claimed delivery back to wait in PostgreSQL without counting an attempt.
 * Delays become timestamps on the database clock (now() + delay), the same clock
 * the scheduler compares against, so host/database clock skew can't shift retries.
 */
async function park(deliveryId: string, leaseToken: string, delayMs: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET state = 'scheduled', next_attempt_at = now() + make_interval(secs => $3::float8 / 1000), park_count = park_count + 1,
            lease_token = NULL, lease_until = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND lease_token = $2`,
    [deliveryId, leaseToken, delayMs],
  )
}

export function wirePayload(ev: EventForSend): string {
  return JSON.stringify({
    id: ev.id,
    type: ev.type,
    created_at: ev.created_at.toISOString(),
    ...(ev.ordering_key ? { ordering_key: ev.ordering_key, sequence: Number(ev.sequence) } : {}),
    data: ev.payload,
  })
}

export async function handleTicket(t: Ticket, redelivered: boolean): Promise<TicketResult> {
  const received = Date.now()
  const leaseToken = randomUUID()
  const d = await claim(t, redelivered, leaseToken)
  const claimMs = Date.now() - received
  const clockOffsetMs = d ? d.db_now.getTime() - Date.now() : 0
  if (!d) {
    ticketsHandled.inc({ result: 'stale' })
    return 'stale'
  }

  // Took over from a worker that died mid-attempt: record that its attempt's fate is unknown.
  let attemptCount = d.attempt_count
  if (d.prev_state === 'in_flight') {
    attemptCount += 1
    await pool.query(
      `INSERT INTO attempts (delivery_id, attempt_no, trigger, started_at, error_class, error_message, outcome, worker_id)
       VALUES ($1, $2, $3, $4, 'worker_lost', $5, 'lost', $6)`,
      [
        d.id,
        attemptCount,
        d.attempt_count === 0 ? 'initial' : 'retry',
        d.prev_updated_at,
        `Worker ${d.prev_claimed_by ?? '?'} stopped before recording a result; the receiver may or may not have received this attempt`,
        d.prev_claimed_by,
      ],
    )
    await pool.query('UPDATE deliveries SET attempt_count = $2 WHERE id = $1', [d.id, attemptCount])
    ticketsHandled.inc({ result: 'stolen_lease' })
    logger.warn({ deliveryId: d.id, previousWorker: d.prev_claimed_by }, 'took over an in-flight delivery from a lost worker')
  }

  const { rows } = await pool.query<
    EndpointRow & { pause_remaining_ms: number; ev_id: string; ev_type: string; ev_payload: Record<string, unknown>; ev_ordering_key: string | null; ev_sequence: string | null; ev_created_at: Date }
  >(
    `SELECT e.*, GREATEST(0, EXTRACT(EPOCH FROM (e.paused_until - now())) * 1000)::int AS pause_remaining_ms, ev.id AS ev_id, ev.type AS ev_type, ev.payload AS ev_payload, ev.ordering_key AS ev_ordering_key,
            ev.sequence AS ev_sequence, ev.created_at AS ev_created_at
       FROM endpoints e JOIN events ev ON ev.id = $2 WHERE e.id = $1`,
    [d.endpoint_id, d.event_id],
  )
  const ep = rows[0]
  if (!ep || ep.status !== 'active') {
    await pool.query(
      `UPDATE deliveries SET state = 'failed', last_error_class = 'endpoint_disabled', lease_token = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND lease_token = $2`,
      [d.id, leaseToken],
    )
    ticketsHandled.inc({ result: 'endpoint_disabled' })
    return 'endpoint_disabled'
  }

  if (ep.pause_remaining_ms > 0) {
    await park(d.id, leaseToken, ep.pause_remaining_ms + Math.floor(Math.random() * 500))
    ticketsHandled.inc({ result: 'paused_parked' })
    return 'paused_parked'
  }

  // A failing endpoint is probed one request at a time instead of tying up its full allowance.
  const limit = ep.consecutive_failures >= config.delivery.probeAfterFailures ? 1 : ep.max_concurrency
  const slot = await acquireSlot(redis, ep.id, limit, config.delivery.leaseMs)
  const prepMs = Date.now() - received
  if (prepMs > 1000) logger.warn({ deliveryId: d.id, claimMs, prepMs }, 'slow ticket preparation (database or Valkey latency)')
  if (!slot) {
    const jitter = Math.floor(Math.random() * config.delivery.busyRequeueMs)
    await park(d.id, leaseToken, config.delivery.busyRequeueMs + jitter)
    ticketsHandled.inc({ result: 'busy_parked' })
    return 'busy_parked'
  }

  workerInFlight.inc()
  try {
    await attempt(d, attemptCount, ep, {
      id: ep.ev_id,
      type: ep.ev_type,
      payload: ep.ev_payload,
      ordering_key: ep.ev_ordering_key,
      sequence: ep.ev_sequence,
      created_at: ep.ev_created_at,
    }, leaseToken, clockOffsetMs)
  } finally {
    workerInFlight.dec()
    await releaseSlot(redis, slot).catch((err: Error) => logger.warn({ err: err.message }, 'slot release failed; lease will expire'))
  }
  ticketsHandled.inc({ result: 'attempted' })
  return 'attempted'
}

function triggerOf(d: DeliveryRow, attemptCount: number, recovered: boolean): 'initial' | 'retry' | 'replay' | 'recovered' {
  if (recovered) return 'recovered'
  if (d.replay_count > 0 && d.window_started_at === null) return 'replay'
  return attemptCount === 0 ? 'initial' : 'retry'
}

async function attempt(d: ClaimedRow, attemptCount: number, ep: EndpointRow, ev: EventForSend, leaseToken: string, clockOffsetMs: number): Promise<void> {
  const attemptNo = attemptCount + 1
  const trigger = triggerOf(d, d.attempt_count, d.prev_state === 'in_flight')
  // Every persisted timestamp is on the database clock: the offset was measured at claim time.
  const dbNow = () => new Date(Date.now() + clockOffsetMs)
  const startedAt = dbNow()
  const body = wirePayload(ev)
  const secrets = activeSigningSecrets({ secretCurrent: ep.secret_current, secretPrevious: ep.secret_previous, previousExpiresAt: ep.previous_expires_at }, startedAt)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'WebhookPlatform/1.0',
    'webhook-id': ev.id,
    'webhook-delivery': d.id,
    'webhook-attempt': String(attemptNo),
    // Receivers compare t with their own wall clock, so sign with this host's wall clock.
    'webhook-signature': signatureHeader(secrets, Math.floor(Date.now() / 1000), body),
  }
  if (ev.ordering_key) {
    headers['webhook-ordering-key'] = ev.ordering_key
    headers['webhook-sequence'] = String(ev.sequence)
  }

  const result: SendResult = await sendWebhook({
    url: ep.url,
    body,
    headers,
    timeoutMs: config.delivery.timeoutMs,
    bodyLimit: config.delivery.responseBodyLimit,
    allowHttp: config.ssrf.allowHttp,
    allowlist: config.ssrf.allowlist,
  })

  const classification = result.kind === 'response' ? classifyStatus(result.status) : classifyTransportError(result.errorClass)
  const finishedAt = dbNow()
  // The retry window starts at the first attempt, not at event creation: if the platform itself was
  // down or backlogged, that time must not count against the customer's endpoint.
  const retryDeadline = retryWindowDeadline(d.window_started_at, startedAt, config.delivery.retryHorizonSeconds)
  const outcome = decideOutcome({
    classification,
    attemptNo,
    now: finishedAt,
    retryDeadline,
    retryAfterSeconds: result.kind === 'response' && result.status === 429 ? parseRetryAfter(result.headers['retry-after'], finishedAt) : null,
    policy: config.delivery,
  })

  await withTransaction((client) =>
    record(client, { d, ep, attemptNo, trigger, startedAt, retryDeadline, result, errorClass: classification.errorClass, outcome, leaseToken, signatures: secrets.length }),
  )

  attemptsTotal.inc({ error_class: classification.errorClass, outcome: outcome.outcome })
  attemptLatency.observe({ outcome: outcome.outcome }, result.latencyMs / 1000)
}

interface RecordArgs {
  d: ClaimedRow
  ep: EndpointRow
  attemptNo: number
  trigger: string
  startedAt: Date
  retryDeadline: Date
  result: SendResult
  errorClass: string
  outcome: Outcome
  leaseToken: string
  signatures: number
}

async function record(client: pg.PoolClient, a: RecordArgs): Promise<void> {
  const { d, ep, outcome, result } = a
  const status = result.kind === 'response' ? result.status : null
  // The retry delay was decided here; the database turns it into a timestamp on its own clock.
  const retryDelayMs = outcome.state === 'scheduled' ? outcome.delayMs : null
  const updated = await client.query<{ window_started_at: Date; next_attempt_at: Date | null }>(
    `UPDATE deliveries
        SET state = $3, next_attempt_at = now() + make_interval(secs => $4::float8 / 1000), attempt_count = $5, last_status_code = $6, last_error_class = $7,
            first_attempt_at = COALESCE(first_attempt_at, $8), window_started_at = COALESCE(window_started_at, $8),
            last_attempt_at = $8, delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END,
            retry_deadline = $9, lease_token = NULL, lease_until = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND lease_token = $2
      RETURNING window_started_at, next_attempt_at`,
    [d.id, a.leaseToken, outcome.state, retryDelayMs, a.attemptNo, status, a.errorClass, a.startedAt, a.retryDeadline],
  )
  // Lost the lease (another worker took over after we stalled): log what we saw, change nothing else.
  const superseded = updated.rowCount === 0
  await client.query(
    `INSERT INTO attempts (delivery_id, attempt_no, trigger, started_at, latency_ms, status_code, error_class, error_message,
                           response_body, outcome, next_attempt_at, worker_id, resolved_ip, signatures_sent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      d.id,
      a.attemptNo,
      a.trigger,
      a.startedAt,
      result.latencyMs,
      status,
      a.errorClass,
      result.kind === 'error' ? result.message : outcome.exhausted ? 'Retry window exhausted' : null,
      result.kind === 'response' ? result.body : null,
      superseded ? 'superseded' : outcome.outcome,
      superseded ? null : (updated.rows[0]?.next_attempt_at ?? null),
      config.instanceId,
      result.ip,
      a.signatures,
    ],
  )
  if (superseded) return

  let failingSince: Date | null = null
  if (outcome.state === 'delivered') {
    // Skip the write when nothing changes: no failure streak to clear and last_success_at is fresh.
    await client.query(
      `UPDATE endpoints SET consecutive_failures = 0, failing_since = NULL, last_success_at = now(), updated_at = now()
        WHERE id = $1 AND (consecutive_failures <> 0 OR failing_since IS NOT NULL OR last_success_at IS NULL OR last_success_at < now() - interval '5 seconds')`,
      [ep.id],
    )
  } else if (outcome.endpointFailure) {
    const r = await client.query<{ failing_since: Date }>(
      `UPDATE endpoints
          SET consecutive_failures = consecutive_failures + 1, failing_since = COALESCE(failing_since, $2),
              last_failure_at = now(), paused_until = GREATEST(paused_until, now() + make_interval(secs => $3::float8 / 1000)), updated_at = now()
        WHERE id = $1 RETURNING failing_since`,
      [ep.id, a.startedAt, outcome.pauseUntil ? outcome.delayMs : null],
    )
    failingSince = r.rows[0]?.failing_since ?? null
  }

  if (outcome.disableReason) {
    const detail = result.kind === 'error' ? result.message : `The last attempt got HTTP ${status}.`
    await disableEndpoint(client, ep.id, outcome.disableReason, detail)
  } else if (outcome.exhausted) {
    // Disable only if the endpoint hasn't succeeded once during this delivery's whole retry window.
    const windowStart = updated.rows[0].window_started_at
    if (failingSince && failingSince.getTime() <= windowStart.getTime()) {
      await disableEndpoint(
        client,
        ep.id,
        'retry_horizon_exhausted',
        `No delivery has succeeded since ${failingSince.toISOString()}; ${a.attemptNo} attempts of delivery ${d.id} failed (last: ${a.errorClass}).`,
      )
    }
  }
}
