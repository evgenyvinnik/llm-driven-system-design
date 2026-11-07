/**
 * Consumer group `car-state`: keeps the car_state projection and decides when a car has missed (or is
 * certain to miss) its connection.
 *
 * Per message: find the cars the event concerns, refold each car's timeline, write its row. Then, live
 * only (never during replay), two decisions, each appended to the event store in the same transaction:
 *
 * - TrainDeparted: every car whose current plan put it on this run but which is not in the consist has
 *   missed its connection (`departed_without_car`).
 * - TrainDelayed: for every car riding the delayed run, if the new arrival plus the yard's minimum
 *   connection is after the planned departure of its next leg, the connection is already lost
 *   (`inbound_delay`, predicted). This is the early warning: hours before the outbound train leaves.
 *
 * ConnectionMissed carries a dedupe key per (trip, plan version, leg), so the predicted miss and the later
 * actual departure without the car produce one event, and so does a redelivery.
 * @module consumers/car-state/handler
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { CarState } from '../../domain/car-fold.js'
import { append } from '../../shared/event-store.js'
import { causedBy, type AnyEnvelope, type EventEnvelope } from '../../shared/events/envelope.js'
import type { EventType } from '../../shared/events/schemas.js'
import { nowMs } from '../../shared/clock.js'
import { runInfo, yardById } from '../../shared/network.js'
import { affectedCars, CAR_FACTS, TRAIN_FACTS } from '../affected.js'
import { refreshCar } from './projection.js'
import type { HandlerContext } from '../../shared/consumer.js'

export const CAR_STATE_TYPES: EventType[] = [...CAR_FACTS, ...TRAIN_FACTS, 'TripPlanCreated', 'TripPlanRevised', 'ConnectionMissed']

/** A fact about a car the registry does not know yet (its waybill has not arrived). Retried, then dead-lettered. */
export class UnknownCarError extends Error {
  constructor(readonly carId: string) {
    super(`Car ${carId} is not in the car registry (waybill not received?)`)
  }
}

async function isRegistered(tx: PoolClient, carId: string): Promise<boolean> {
  const { rowCount } = await tx.query('SELECT 1 FROM cars WHERE car_id = $1', [carId])
  return (rowCount ?? 0) > 0
}

export async function handleCarState(e: AnyEnvelope, ctx: HandlerContext): Promise<void> {
  const { tx } = ctx
  const cars = await affectedCars(tx, e)
  const states = new Map<string, CarState>()
  for (const carId of cars) {
    if (!(await isRegistered(tx, carId))) {
      // A train event must not be held hostage by one unknown car in its consist; the car's own fact is.
      if (e.topic === 'car') throw new UnknownCarError(carId)
      continue
    }
    states.set(carId, await refreshCar(tx, carId))
  }
  if (e.type === 'TrainDeparted') await detectLeftBehind(tx, e, states)
  if (e.type === 'TrainDelayed') await detectPredictedMisses(tx, e, states)
}

interface PlannedRow {
  trip_id: string
  car_id: string
  shipper_id: string
  plan_version: number
  leg_seq: number
  train_id: string
  from_yard: string
  planned_departure: Date
}

async function detectLeftBehind(tx: PoolClient, e: EventEnvelope<'TrainDeparted'>, states: Map<string, CarState>): Promise<void> {
  const p = e.payload
  const consist = new Set(p.consist)
  const { rows } = await tx.query<PlannedRow>(
    `SELECT pl.trip_id, pl.car_id, tp.shipper_id, pl.plan_version, pl.leg_seq, pl.train_id, pl.from_yard, pl.planned_departure
       FROM plan_legs_current pl JOIN trip_plans tp USING (trip_id) WHERE pl.run_id = $1`,
    [p.runId],
  )
  for (const row of rows) {
    if (consist.has(row.car_id)) continue
    const s = states.get(row.car_id)
    if (!s || s.status === 'delivered' || s.status === 'off_network') continue
    const minConn = (yardById.get(row.from_yard)?.minConnectionMinutes ?? 240) * 60_000
    let availableAt = Date.parse(e.occurredAt)
    if (s.status === 'bad_ordered' && s.repairUntil) availableAt = Math.max(availableAt, Date.parse(s.repairUntil))
    if (s.status === 'in_transit' && s.trainRunId) {
      const inbound = runInfo(s.trainRunId)
      const eta = s.delays[s.trainRunId] ? Date.parse(s.delays[s.trainRunId]) : (inbound?.scheduledArrival ?? availableAt)
      availableAt = Math.max(availableAt, eta + minConn)
    }
    await emitMiss(tx, e, row, 'departed_without_car', false, availableAt, s.status === 'in_transit' ? s.trainRunId : null)
  }
}

async function detectPredictedMisses(tx: PoolClient, e: EventEnvelope<'TrainDelayed'>, states: Map<string, CarState>): Promise<void> {
  const p = e.payload
  const run = runInfo(p.runId)
  if (!run) return
  const newArrival = Date.parse(p.newEtaAt)
  const minConn = (yardById.get(run.to)?.minConnectionMinutes ?? 240) * 60_000
  const { rows } = await tx.query<PlannedRow>(
    `SELECT pl.trip_id, pl.car_id, tp.shipper_id, pl.plan_version, pl.leg_seq, pl.train_id, pl.from_yard, pl.planned_departure
       FROM plan_legs_current pl JOIN trip_plans tp USING (trip_id)
      WHERE pl.car_id IN (SELECT car_id FROM train_run_cars WHERE run_id = $1)
        AND pl.from_yard = $2 AND pl.run_id <> $1
      ORDER BY pl.car_id, pl.leg_seq`,
    [p.runId, run.to],
  )
  for (const row of rows) {
    const s = states.get(row.car_id)
    if (!s || s.trainRunId !== p.runId) continue
    if (newArrival + minConn > row.planned_departure.getTime()) {
      await emitMiss(tx, e, row, 'inbound_delay', true, newArrival + minConn, p.runId)
    }
  }
}

async function emitMiss(tx: PoolClient, cause: AnyEnvelope, row: PlannedRow, reason: 'departed_without_car' | 'inbound_delay', predicted: boolean, availableAt: number, inboundRunId: string | null) {
  const runId = (cause.payload as { runId: string }).runId
  const missedRun = reason === 'inbound_delay' ? await plannedRunOf(tx, row.trip_id, row.leg_seq) : runId
  await append(tx, {
    eventId: randomUUID(),
    type: 'ConnectionMissed',
    occurredAt: new Date(Math.max(nowMs(), Date.parse(cause.occurredAt))).toISOString(),
    producer: 'svc:car-state',
    ...causedBy(cause),
    dedupeKey: `cm:${row.trip_id}:${row.plan_version}:${row.leg_seq}`,
    payload: {
      carId: row.car_id,
      tripId: row.trip_id,
      shipperId: row.shipper_id,
      planVersion: row.plan_version,
      legSeq: row.leg_seq,
      runId: missedRun,
      trainId: row.train_id,
      yardId: row.from_yard,
      plannedDeparture: row.planned_departure.toISOString(),
      reason,
      predicted,
      availableAt: new Date(availableAt).toISOString(),
      inboundRunId,
    },
  })
}

async function plannedRunOf(tx: PoolClient, tripId: string, legSeq: number): Promise<string> {
  const { rows } = await tx.query<{ run_id: string }>('SELECT run_id FROM plan_legs_current WHERE trip_id = $1 AND leg_seq = $2', [tripId, legSeq])
  return rows[0].run_id
}
