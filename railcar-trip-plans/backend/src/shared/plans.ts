/**
 * The trip-plan aggregate (event-sourced) and the planner.
 *
 * A trip plan is a decision, not a fact, so unlike car state it has a command side: its stream
 * (plan-<tripId>) holds only TripPlanCreated and TripPlanRevised, the stream version equals the plan
 * version, and a revision appends with `expectedVersion` = the version the writer read. Two writers (the
 * replanner and an operator) revising the same plan cannot both win: the second gets a ConcurrencyError,
 * reloads, and decides again.
 *
 * The read model (trip_plans, trip_plan_versions, plan_legs_current) is an inline projection, written in
 * the same transaction as the event so the replanner and car-state always see the plan they just wrote.
 * `applyPlanEvent` is the only writer; replay calls it with shadow tables.
 * @module shared/plans
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Queryable } from './db.js'
import { append, readStream } from './event-store.js'
import type { AnyEnvelope, EventEnvelope } from './events/envelope.js'
import type { Leg, Payloads } from './events/schemas.js'
import { materializeRuns, ROUTES, trainById, yardById } from './network.js'
import { nowMs } from './clock.js'

export interface PlanVersion {
  version: number
  legs: Leg[]
  reasonCode: string
  reasonText: string
  revisedBy: string
  eventId: string
  occurredAt: string
}

export interface PlanAggregate {
  tripId: string
  carId: string
  shipperId: string
  originYard: string
  destinationYard: string
  destinationCustomer: string
  handoffRoad: string | null
  releasedAt: string
  version: number
  legs: Leg[]
  versions: PlanVersion[]
}

export function foldPlan(events: AnyEnvelope[]): PlanAggregate | null {
  let plan: PlanAggregate | null = null
  for (const e of events) {
    if (e.type === 'TripPlanCreated') {
      const p = e.payload
      plan = {
        tripId: p.tripId, carId: p.carId, shipperId: p.shipperId, originYard: p.originYard, destinationYard: p.destinationYard,
        destinationCustomer: p.destinationCustomer, handoffRoad: p.handoffRoad, releasedAt: p.releasedAt, version: 1, legs: p.legs,
        versions: [{ version: 1, legs: p.legs, reasonCode: p.reason.code, reasonText: p.reason.text, revisedBy: 'planner', eventId: e.eventId, occurredAt: e.occurredAt }],
      }
    } else if (e.type === 'TripPlanRevised' && plan) {
      const p = e.payload
      plan.version = p.version
      plan.legs = p.legs
      plan.versions.push({ version: p.version, legs: p.legs, reasonCode: p.reason.code, reasonText: p.reason.text, revisedBy: p.revisedBy, eventId: e.eventId, occurredAt: e.occurredAt })
    }
  }
  return plan
}

export async function loadPlan(q: Queryable, tripId: string): Promise<PlanAggregate | null> {
  return foldPlan(await readStream(q, `plan-${tripId}`))
}

export interface PlanTables {
  tripPlans: string
  versions: string
  legs: string
}
export const LIVE_PLAN_TABLES: PlanTables = { tripPlans: 'trip_plans', versions: 'trip_plan_versions', legs: 'plan_legs_current' }

/** The plan projection's single writer: applies one plan event to the given tables. */
export async function applyPlanEvent(tx: Queryable, e: EventEnvelope<'TripPlanCreated'> | EventEnvelope<'TripPlanRevised'>, t: PlanTables = LIVE_PLAN_TABLES): Promise<void> {
  const p = e.payload
  if (e.type === 'TripPlanCreated') {
    const c = e.payload as Payloads['TripPlanCreated']
    await tx.query(
      `INSERT INTO ${t.tripPlans} (trip_id, car_id, shipper_id, origin_yard, destination_yard, destination_customer, handoff_road, released_at, current_version, legs, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)
       ON CONFLICT (trip_id) DO NOTHING`,
      [c.tripId, c.carId, c.shipperId, c.originYard, c.destinationYard, c.destinationCustomer, c.handoffRoad, c.releasedAt, JSON.stringify(c.legs), e.occurredAt],
    )
  } else {
    const r = e.payload as Payloads['TripPlanRevised']
    const res = await tx.query(`UPDATE ${t.tripPlans} SET current_version = $2, legs = $3, updated_at = $4 WHERE trip_id = $1 AND current_version < $2`, [
      r.tripId, r.version, JSON.stringify(r.legs), e.occurredAt,
    ])
    if (res.rowCount === 0) return
  }
  const version = e.type === 'TripPlanCreated' ? 1 : (p as Payloads['TripPlanRevised']).version
  const revisedBy = e.type === 'TripPlanCreated' ? 'planner' : (p as Payloads['TripPlanRevised']).revisedBy
  await tx.query(
    `INSERT INTO ${t.versions} (trip_id, version, legs, reason_code, reason_text, revised_by, event_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    [p.tripId, version, JSON.stringify(p.legs), p.reason.code, p.reason.text, revisedBy, e.eventId, e.occurredAt],
  )
  await tx.query(`DELETE FROM ${t.legs} WHERE trip_id = $1`, [p.tripId])
  for (const leg of p.legs) {
    await tx.query(
      `INSERT INTO ${t.legs} (trip_id, leg_seq, car_id, plan_version, run_id, train_id, from_yard, to_yard, planned_departure, planned_arrival)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.tripId, leg.seq, p.carId, version, leg.runId, leg.trainId, leg.fromYard, leg.toYard, leg.plannedDeparture, leg.plannedArrival],
    )
  }
}

// ── Capacity ──

/** Runs that can no longer take cars: cancelled, or already departed. */
export async function unusableRuns(q: Queryable, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const { rows } = await q.query<{ run_id: string }>(
    `SELECT DISTINCT payload->>'runId' AS run_id FROM events WHERE type IN ('TrainCancelled', 'TrainDeparted') AND stream_id = ANY($1)`,
    [runIds.map((r) => `train-${r}`)],
  )
  return new Set(rows.map((r) => r.run_id))
}

/**
 * Reserves a seat on the first run of any of `trainIds` departing at or after `readyAt` that has capacity,
 * is not cancelled and has not departed. Runs are locked one at a time in departure order, so concurrent
 * reservations queue on a run row rather than deadlock.
 */
export async function reserveFirstRun(
  tx: PoolClient,
  trainIds: string[],
  readyAt: number,
  tripId: string,
  reservedBy: string,
  horizonHours: number,
  exclude: Set<string> = new Set(),
): Promise<{ runId: string; trainId: string; departure: string; arrival: string } | null> {
  await materializeRuns(tx, readyAt, readyAt + horizonHours * 3_600_000)
  const { rows } = await tx.query<{ run_id: string; train_id: string; scheduled_departure: Date; scheduled_arrival: Date; capacity: number }>(
    `SELECT run_id, train_id, scheduled_departure, scheduled_arrival, capacity FROM train_runs
      WHERE train_id = ANY($1) AND scheduled_departure >= $2 AND scheduled_departure < $3
      ORDER BY scheduled_departure, run_id`,
    [trainIds, new Date(readyAt).toISOString(), new Date(readyAt + horizonHours * 3_600_000).toISOString()],
  )
  const gone = await unusableRuns(tx, rows.map((r) => r.run_id))
  for (const run of rows) {
    if (exclude.has(run.run_id) || gone.has(run.run_id)) continue
    await tx.query('SELECT 1 FROM train_runs WHERE run_id = $1 FOR UPDATE', [run.run_id])
    const { rows: c } = await tx.query<{ n: number; mine: boolean }>(
      'SELECT COUNT(*)::int AS n, bool_or(trip_id = $2) AS mine FROM run_reservations WHERE run_id = $1',
      [run.run_id, tripId],
    )
    if (c[0].mine || c[0].n < run.capacity) {
      await tx.query('INSERT INTO run_reservations (run_id, trip_id, reserved_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [run.run_id, tripId, reservedBy])
      return { runId: run.run_id, trainId: run.train_id, departure: run.scheduled_departure.toISOString(), arrival: run.scheduled_arrival.toISOString() }
    }
  }
  return null
}

/** Plans legs for `trains` in sequence, reserving capacity; each leg starts after the previous arrival plus the yard's minimum connection. */
export async function planLegs(tx: PoolClient, trains: string[], readyAt: number, tripId: string, reservedBy: string, firstSeq = 0, horizonHours = 120): Promise<Leg[] | null> {
  const legs: Leg[] = []
  let ready = readyAt
  for (let i = 0; i < trains.length; i++) {
    const train = trainById.get(trains[i])
    if (!train) throw new Error(`unknown train ${trains[i]}`)
    const run = await reserveFirstRun(tx, [train.trainId], ready, tripId, reservedBy, horizonHours)
    if (!run) return null
    legs.push({ seq: firstSeq + i, trainId: run.trainId, runId: run.runId, fromYard: train.from, toYard: train.to, plannedDeparture: run.departure, plannedArrival: run.arrival })
    ready = Date.parse(run.arrival) + (yardById.get(train.to)?.minConnectionMinutes ?? 240) * 60_000
  }
  return legs
}

/** Drops reservations for runs this trip no longer uses. */
export async function releaseUnusedReservations(tx: PoolClient, tripId: string, keepRuns: string[]): Promise<void> {
  await tx.query('DELETE FROM run_reservations WHERE trip_id = $1 AND NOT (run_id = ANY($2))', [tripId, keepRuns])
}

// ── Commands ──

export interface CreateTripInput {
  tripId: string
  carId: string
  shipperId: string
  originYard: string
  destinationYard: string
  destinationCustomer: string
  via?: string | null
  handoffRoad?: string | null
  releasedAt: string
  correlationId?: string
}

export class PlanningError extends Error {}

/** Plans and appends TripPlanCreated (idempotent on trip id). */
export async function createTrip(tx: PoolClient, input: CreateTripInput, producer: string) {
  const routeKey = input.via ? `${input.originYard}-${input.destinationYard}-via-${input.via}` : `${input.originYard}-${input.destinationYard}`
  const trains = ROUTES[routeKey]
  if (!trains) throw new PlanningError(`No route from ${input.originYard} to ${input.destinationYard}${input.via ? ` via ${input.via}` : ''}`)
  const existing = await loadPlan(tx, input.tripId)
  if (existing) return { status: 'duplicate' as const, plan: existing }
  // Released at the customer → pulled (or received in interchange) within ~3 h → the origin yard's minimum connection.
  const readyAt = Date.parse(input.releasedAt) + 3 * 3_600_000 + (yardById.get(input.originYard)?.minConnectionMinutes ?? 240) * 60_000
  const legs = await planLegs(tx, trains, readyAt, input.tripId, 'planner')
  if (!legs) throw new PlanningError('No train with capacity within the planning horizon')
  const eventId = randomUUID()
  const payload: Payloads['TripPlanCreated'] = {
    tripId: input.tripId, carId: input.carId, shipperId: input.shipperId, originYard: input.originYard, destinationYard: input.destinationYard,
    destinationCustomer: input.destinationCustomer, handoffRoad: input.handoffRoad ?? null, releasedAt: input.releasedAt, version: 1, legs,
    reason: { code: 'initial', text: `Initial plan: ${trains.join(' → ')}`, missedRunId: null, yardId: null },
  }
  const occurredAt = new Date(nowMs()).toISOString()
  const result = await append(tx, { eventId, type: 'TripPlanCreated', occurredAt, producer, payload, correlationId: input.correlationId ?? eventId, expectedVersion: 0, dedupeKey: `tpc:${input.tripId}` })
  if (result.status === 'appended') {
    await applyPlanEvent(tx, { eventId, type: 'TripPlanCreated', occurredAt, payload } as EventEnvelope<'TripPlanCreated'>)
  }
  return { status: result.status, plan: await loadPlan(tx, input.tripId) }
}

export interface ReviseInput {
  tripId: string
  expectedVersion: number
  legs: Leg[]
  reason: Payloads['TripPlanRevised']['reason']
  revisedBy: string
  sagaId: string | null
  producer: string
  correlationId: string
  causationId: string | null
}

/** Appends TripPlanRevised with optimistic concurrency and updates the inline projection. Throws ConcurrencyError. */
export async function revisePlan(tx: PoolClient, plan: PlanAggregate, input: ReviseInput): Promise<{ eventId: string; version: number }> {
  const eventId = randomUUID()
  const payload: Payloads['TripPlanRevised'] = {
    tripId: plan.tripId, carId: plan.carId, shipperId: plan.shipperId, version: input.expectedVersion + 1, previousVersion: input.expectedVersion,
    legs: input.legs, reason: input.reason, revisedBy: input.revisedBy, sagaId: input.sagaId,
  }
  const occurredAt = new Date(nowMs()).toISOString()
  await append(tx, {
    eventId, type: 'TripPlanRevised', occurredAt, producer: input.producer, payload, expectedVersion: input.expectedVersion,
    correlationId: input.correlationId, causationId: input.causationId, dedupeKey: `tpr:${plan.tripId}:${input.expectedVersion + 1}`,
  })
  await applyPlanEvent(tx, { eventId, type: 'TripPlanRevised', occurredAt, payload } as EventEnvelope<'TripPlanRevised'>)
  await releaseUnusedReservations(tx, plan.tripId, input.legs.map((l) => l.runId))
  return { eventId, version: input.expectedVersion + 1 }
}
