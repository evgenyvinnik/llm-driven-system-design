/**
 * Consumer group `exceptions`: the operations exceptions board.
 *
 * Decisions (append ExceptionOpened / ExceptionResolved to the event store):
 *   ConnectionMissed              → open missed_connection
 *   ReplanStarted (cancellation)  → open train_cancelled
 *   ReplanFailed                  → open no_capacity
 *   CarBadOrdered                 → open bad_order
 *   ReplanCompleted               → resolve the trip's open missed_connection / train_cancelled
 *   sweep (event-time watermark)  → open dwell_exceeded; resolve bad_order / dwell_exceeded once the car moved
 *
 * Projection: the `exceptions` table is written only by applying ExceptionOpened / ExceptionResolved, which
 * this group also consumes (including resolutions an operator made through the API). Replay applies the
 * same events to a shadow table. Exception ids are deterministic, so a redelivered decision is a no-op.
 * @module consumers/exceptions/handler
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Queryable } from '../../shared/db.js'
import { withTransaction } from '../../shared/db.js'
import { append, fieldWatermark } from '../../shared/event-store.js'
import { causedBy, type AnyEnvelope } from '../../shared/events/envelope.js'
import type { EventType, Payloads } from '../../shared/events/schemas.js'
import type { HandlerContext } from '../../shared/consumer.js'
import { nowMs } from '../../shared/clock.js'
import { config } from '../../shared/config.js'
import { dwellFor } from '../../shared/network.js'

export const EXCEPTION_TYPES: EventType[] = ['ConnectionMissed', 'CarBadOrdered', 'ReplanStarted', 'ReplanFailed', 'ReplanCompleted', 'ExceptionOpened', 'ExceptionResolved']

type Opened = Payloads['ExceptionOpened']

const simNow = () => new Date(nowMs()).toISOString()

export async function applyExceptionEvent(q: Queryable, e: AnyEnvelope, table = 'exceptions'): Promise<void> {
  if (e.type === 'ExceptionOpened') {
    const p = e.payload
    await q.query(
      `INSERT INTO ${table} (exception_id, car_id, trip_id, shipper_id, type, severity, status, yard_id, summary, detail, opened_at, opened_event_id, version)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11, 1) ON CONFLICT (exception_id) DO NOTHING`,
      [p.exceptionId, p.carId, p.tripId, p.shipperId, p.type, p.severity, p.yardId, p.summary, JSON.stringify(p.detail), e.occurredAt, e.eventId],
    )
  } else if (e.type === 'ExceptionResolved') {
    const p = e.payload
    await q.query(
      `UPDATE ${table} SET status = 'resolved', resolved_at = $2, resolved_by = $3, resolution = $4, version = version + 1
        WHERE exception_id = $1 AND status = 'open'`,
      [p.exceptionId, e.occurredAt, p.resolvedBy, p.resolution],
    )
  }
}

async function open(tx: PoolClient, cause: Pick<AnyEnvelope, 'eventId' | 'correlationId'> | null, p: Opened, occurredAt = simNow()): Promise<void> {
  await append(tx, {
    eventId: randomUUID(),
    type: 'ExceptionOpened',
    occurredAt,
    producer: 'svc:exceptions',
    ...(cause ? causedBy(cause) : {}),
    dedupeKey: `exo:${p.exceptionId}`,
    payload: p,
  })
}

export async function resolveException(tx: PoolClient, cause: Pick<AnyEnvelope, 'eventId' | 'correlationId'> | null, exceptionId: string, carId: string, resolution: string, resolvedBy: string, expectedVersion?: number) {
  return append(tx, {
    eventId: randomUUID(),
    type: 'ExceptionResolved',
    occurredAt: simNow(),
    producer: resolvedBy.startsWith('svc:') ? resolvedBy : `ops:${resolvedBy}`,
    ...(cause ? causedBy(cause) : {}),
    dedupeKey: `exr:${exceptionId}`,
    expectedVersion,
    payload: { exceptionId, carId, resolution, resolvedBy },
  })
}

/** Open exceptions of the given types for a trip, read from the log (not the projection, which may lag). */
async function openForTrip(tx: PoolClient, tripId: string, types: string[]): Promise<Array<{ id: string; carId: string }>> {
  const { rows } = await tx.query<{ id: string; car_id: string }>(
    `SELECT o.payload->>'exceptionId' AS id, o.payload->>'carId' AS car_id FROM events o
      WHERE o.type = 'ExceptionOpened' AND o.payload->>'tripId' = $1 AND o.payload->>'type' = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.type = 'ExceptionResolved' AND r.stream_id = o.stream_id)`,
    [tripId, types],
  )
  return rows.map((r) => ({ id: r.id, carId: r.car_id }))
}

async function shipperOf(tx: PoolClient, carId: string): Promise<{ tripId: string | null; shipperId: string | null }> {
  const { rows } = await tx.query<{ trip_id: string; shipper_id: string }>('SELECT trip_id, shipper_id FROM trip_plans WHERE car_id = $1 ORDER BY released_at DESC LIMIT 1', [carId])
  return { tripId: rows[0]?.trip_id ?? null, shipperId: rows[0]?.shipper_id ?? null }
}

export async function handleException(e: AnyEnvelope, ctx: HandlerContext): Promise<void> {
  const { tx } = ctx
  switch (e.type) {
    case 'ExceptionOpened':
    case 'ExceptionResolved':
      await applyExceptionEvent(tx, e)
      return
    case 'ConnectionMissed': {
      const p = e.payload
      const how = p.predicted ? `will miss ${p.runId} (inbound ${p.inboundRunId ?? 'train'} delayed)` : `missed ${p.runId}: train left without it`
      await open(tx, e, {
        exceptionId: `MC-${p.tripId}-v${p.planVersion}-L${p.legSeq}`,
        carId: p.carId, tripId: p.tripId, shipperId: p.shipperId, type: 'missed_connection', severity: 'medium', yardId: p.yardId,
        summary: `${p.carId} ${how} at ${p.yardId}`,
        detail: { runId: p.runId, plannedDeparture: p.plannedDeparture, predicted: p.predicted, reason: p.reason, availableAt: p.availableAt },
      })
      return
    }
    case 'ReplanStarted': {
      const p = e.payload
      if (p.trigger !== 'train_cancelled') return
      await open(tx, e, {
        exceptionId: `TC-${p.tripId}-v${p.fromPlanVersion}-L${p.legSeq}`,
        carId: p.carId, tripId: p.tripId, shipperId: p.shipperId, type: 'train_cancelled', severity: 'medium', yardId: p.yardId,
        summary: `${p.carId}: planned train ${p.missedRunId} was cancelled`,
        detail: { runId: p.missedRunId, sagaId: p.sagaId, attempt: p.attempt },
      })
      return
    }
    case 'ReplanFailed': {
      const p = e.payload
      await open(tx, e, {
        exceptionId: `NC-${p.sagaId}`,
        carId: p.carId, tripId: p.tripId, shipperId: p.shipperId, type: 'no_capacity', severity: 'high', yardId: p.yardId,
        summary: `${p.carId}: no train with capacity out of ${p.yardId}; needs a manual plan`,
        detail: { sagaId: p.sagaId, reason: p.reason },
      })
      return
    }
    case 'CarBadOrdered': {
      const p = e.payload
      const { tripId, shipperId } = await shipperOf(tx, p.carId)
      await open(tx, e, {
        exceptionId: `BO-${p.carId}-${e.occurredAt.slice(0, 16).replace(/[-:T]/g, '')}`,
        carId: p.carId, tripId, shipperId, type: 'bad_order', severity: 'high', yardId: p.yardId,
        summary: `${p.carId} bad-ordered at ${p.yardId}: ${p.defect}`,
        detail: { defect: p.defect, estimatedRepairHours: p.estimatedRepairHours },
      }, e.occurredAt)
      return
    }
    case 'ReplanCompleted': {
      const p = e.payload
      for (const ex of await openForTrip(tx, p.tripId, ['missed_connection', 'train_cancelled'])) {
        await resolveException(tx, e, ex.id, ex.carId, `Replanned v${p.fromPlanVersion} → v${p.toPlanVersion} on ${p.chosenRunId}`, 'svc:replanner')
      }
      return
    }
    default:
      return
  }
}

/**
 * Event-time sweep. "Now" is the watermark: the newest event time seen from the field minus an allowance
 * for lateness, so a replayed or compressed (simulated) timeline gives the same answers as live time.
 */
export async function sweepDwell(): Promise<{ opened: number; resolved: number }> {
  return withTransaction(async (tx) => {
    const field = await fieldWatermark(tx)
    if (!field) return { opened: 0, resolved: 0 }
    const watermark = new Date(field.getTime() - config.exceptions.watermarkLagMinutes * 60_000)
    let opened = 0
    let resolved = 0
    const { rows: atYard } = await tx.query<{ car_id: string; trip_id: string | null; shipper_id: string | null; location_id: string; arrived_at: Date; to_yard: string | null }>(
      `SELECT cs.car_id, cs.trip_id, cs.shipper_id, cs.location_id, cs.arrived_at, pl.to_yard
         FROM car_state cs LEFT JOIN plan_legs_current pl ON pl.trip_id = cs.trip_id AND pl.leg_seq = cs.current_leg
        WHERE cs.status = 'at_yard' AND cs.arrived_at IS NOT NULL`,
    )
    for (const c of atYard) {
      const block = c.to_yard ?? 'LOCAL'
      const d = dwellFor(c.location_id, block) ?? dwellFor(c.location_id, 'LOCAL')
      if (!d) continue
      // Ready time p90 plus a day for the wait on a daily train: past that, the car is genuinely stuck.
      const limit = c.arrived_at.getTime() + (d.p90 + 24 * 60) * 60_000
      if (limit >= watermark.getTime()) continue
      const hours = Math.round((watermark.getTime() - c.arrived_at.getTime()) / 3_600_000)
      const exceptionId = `DW-${c.car_id}-${c.location_id}-${c.arrived_at.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
      const before = await tx.query('SELECT 1 FROM events WHERE dedupe_key = $1', [`exo:${exceptionId}`])
      if (before.rowCount) continue
      await open(tx, null, {
        exceptionId, carId: c.car_id, tripId: c.trip_id, shipperId: c.shipper_id, type: 'dwell_exceeded', severity: 'low', yardId: c.location_id,
        summary: `${c.car_id} has dwelled ${hours} h at ${c.location_id} (p90 for block ${block} is ${Math.round(d.p90 / 60)} h + one train)`,
        detail: { arrivedAt: c.arrived_at.toISOString(), block, p90Minutes: d.p90, watermark: watermark.toISOString() },
      }, watermark.toISOString())
      opened++
    }
    // Resolve yard-bound exceptions once the car has moved on.
    const { rows: stale } = await tx.query<{ exception_id: string; car_id: string; type: string; status: string | null; location_id: string | null }>(
      `SELECT x.exception_id, x.car_id, x.type, cs.status, cs.location_id FROM exceptions x LEFT JOIN car_state cs USING (car_id)
        WHERE x.status = 'open' AND x.type IN ('bad_order', 'dwell_exceeded')
          AND (cs.status IS NULL OR cs.location_id IS DISTINCT FROM x.yard_id OR cs.status NOT IN ('at_yard', 'bad_ordered')
               OR (x.type = 'bad_order' AND cs.status <> 'bad_ordered'))`,
    )
    for (const s of stale) {
      await resolveException(tx, null, s.exception_id, s.car_id, `Car moved on (${s.status ?? 'unknown'} at ${s.location_id ?? '?'})`, 'svc:exceptions')
      resolved++
    }
    return { opened, resolved }
  })
}

