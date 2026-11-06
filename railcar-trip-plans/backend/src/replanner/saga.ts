/**
 * The replanning process manager (orchestrated saga).
 *
 *   ConnectionMissed / TrainCancelled
 *        │
 *        ▼
 *   started ──reserve seat on next train with capacity──▶ reserved ──revise plan (expected version)──▶ awaiting_eta
 *      │  no train in horizon                               │  plan changed under us                   │ EtaUpdated caused by
 *      ▼                                                    ▼                                          ▼ our revision
 *   failed (ReplanFailed → no_capacity exception)       compensated (seat released)                 completed (ReplanCompleted)
 *                                                                                                       │ chosen train cancelled
 *                                                                                                       ▼
 *                                                                          compensated (seat released) + a child saga, attempt n+1
 *
 * Each step is its own transaction that locks the saga row, does the step's local work (a capacity booking,
 * a plan revision), appends the step's event and moves the state, all together. A crash between steps
 * leaves a saga in a resumable state; the sweeper picks it up. Steps check state first, so a resumed or
 * repeated step is a no-op.
 *
 * Why orchestration rather than choreography: the replan has an order (reserve, then revise, then wait for
 * the ETA, then tell the shipper), a resource that must be given back if a later step fails or the chosen
 * train is cancelled, and a question operations ask constantly: "where is the replan for this car?". One
 * row per saga answers that and holds the compensation logic in one place. ETA and notifications stay
 * choreographed: they react to any plan revision, whoever made it.
 * @module replanner/saga
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from '../shared/db.js'
import { append, ConcurrencyError } from '../shared/event-store.js'
import { causedBy, type AnyEnvelope, type EventEnvelope } from '../shared/events/envelope.js'
import type { Leg } from '../shared/events/schemas.js'
import { nowMs } from '../shared/clock.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { sagaTransitions } from '../shared/metrics.js'
import { TRAINS, yardById } from '../shared/network.js'
import { loadPlan, planLegs, reserveFirstRun, revisePlan } from '../shared/plans.js'

export type SagaState = 'started' | 'reserved' | 'awaiting_eta' | 'completed' | 'failed' | 'compensated' | 'superseded'
export type Trigger = 'inbound_delay' | 'departed_without_car' | 'train_cancelled'

export interface SagaRow {
  saga_id: string
  trip_id: string
  car_id: string
  shipper_id: string
  trigger_type: Trigger
  trigger_event_id: string
  correlation_id: string
  state: SagaState
  attempt: number
  parent_saga_id: string | null
  from_plan_version: number
  to_plan_version: number | null
  leg_seq: number
  yard_id: string
  missed_run_id: string
  ready_at: Date
  chosen_run_id: string | null
  revision_event_id: string | null
  eta_before: { p50: string; p90: string } | null
  eta_after: { p10: string; p50: string; p90: string } | null
}

/** Allowed transitions; anything else is a bug and throws. */
export const TRANSITIONS: Record<SagaState, SagaState[]> = {
  started: ['reserved', 'failed', 'superseded'],
  reserved: ['awaiting_eta', 'compensated', 'failed'],
  awaiting_eta: ['completed', 'compensated'],
  completed: ['compensated'],
  failed: [],
  compensated: [],
  superseded: [],
}

export function canTransition(from: SagaState, to: SagaState): boolean {
  return TRANSITIONS[from].includes(to)
}

const simIso = () => new Date(nowMs()).toISOString()
const meta = (row: SagaRow, causationId: string | null) => ({ producer: 'svc:replanner', correlationId: row.correlation_id, causationId, occurredAt: simIso() })

async function transition(tx: PoolClient, row: SagaRow, to: SagaState, step: string, detail: Record<string, unknown>, patch: Record<string, unknown> = {}): Promise<void> {
  if (!canTransition(row.state, to)) throw new Error(`saga ${row.saga_id}: illegal transition ${row.state} → ${to}`)
  const sets = ['state = $2', 'updated_at = now()', `steps = steps || $3::jsonb`]
  const values: unknown[] = [row.saga_id, to, JSON.stringify([{ step, to, at: new Date().toISOString(), simAt: simIso(), ...detail }])]
  for (const [k, v] of Object.entries(patch)) {
    values.push(v)
    sets.push(`${k} = $${values.length}`)
  }
  await tx.query(`UPDATE replan_sagas SET ${sets.join(', ')} WHERE saga_id = $1`, values)
  row.state = to
  sagaTransitions.inc({ to })
}

export interface StartInput {
  tripId: string
  carId: string
  shipperId: string
  trigger: Trigger
  cause: Pick<AnyEnvelope, 'eventId' | 'correlationId'>
  fromPlanVersion: number
  legSeq: number
  yardId: string
  missedRunId: string
  readyAt: string
  attempt?: number
  parentSagaId?: string | null
}

/** Creates a saga unless one already exists for this (trip, plan version, leg, attempt). Returns its id, or null. */
export async function startSaga(tx: PoolClient, input: StartInput): Promise<string | null> {
  const sagaId = `RP-${randomUUID().slice(0, 8).toUpperCase()}`
  const { rows: eta } = await tx.query<{ p50: Date; p90: Date }>('SELECT p50, p90 FROM car_eta WHERE car_id = $1', [input.carId])
  const etaBefore = eta[0] ? { p50: eta[0].p50.toISOString(), p90: eta[0].p90.toISOString() } : null
  const inserted = await tx.query(
    `INSERT INTO replan_sagas (saga_id, dedupe_key, trip_id, car_id, shipper_id, trigger_type, trigger_event_id, correlation_id, state, attempt,
                               parent_saga_id, from_plan_version, leg_seq, yard_id, missed_run_id, ready_at, eta_before, steps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'started', $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      sagaId, `${input.tripId}:${input.fromPlanVersion}:${input.legSeq}#${input.attempt ?? 1}`, input.tripId, input.carId, input.shipperId, input.trigger, input.cause.eventId,
      input.cause.correlationId, input.attempt ?? 1, input.parentSagaId ?? null, input.fromPlanVersion, input.legSeq, input.yardId, input.missedRunId,
      input.readyAt, etaBefore ? JSON.stringify(etaBefore) : null,
      JSON.stringify([{ step: 'start', to: 'started', at: new Date().toISOString(), simAt: simIso(), trigger: input.trigger, missedRunId: input.missedRunId }]),
    ],
  )
  if (inserted.rowCount === 0) return null
  sagaTransitions.inc({ to: 'started' })
  await append(tx, {
    type: 'ReplanStarted',
    ...causedBy(input.cause),
    producer: 'svc:replanner',
    occurredAt: simIso(),
    dedupeKey: `rps:${sagaId}`,
    payload: {
      sagaId, carId: input.carId, tripId: input.tripId, shipperId: input.shipperId, trigger: input.trigger, fromPlanVersion: input.fromPlanVersion,
      legSeq: input.legSeq, yardId: input.yardId, missedRunId: input.missedRunId, readyAt: input.readyAt, attempt: input.attempt ?? 1, parentSagaId: input.parentSagaId ?? null,
    },
  })
  return sagaId
}

async function lockSaga(tx: PoolClient, sagaId: string): Promise<SagaRow | null> {
  const { rows } = await tx.query<SagaRow>('SELECT * FROM replan_sagas WHERE saga_id = $1 FOR UPDATE', [sagaId])
  return rows[0] ?? null
}

/** Step 1: book a seat on the next train between the same yards that has capacity. */
async function reserveStep(tx: PoolClient, row: SagaRow): Promise<boolean> {
  const plan = await loadPlan(tx, row.trip_id)
  if (!plan || plan.version !== row.from_plan_version) {
    await transition(tx, row, 'superseded', 'reserve', { note: `plan is at v${plan?.version}; someone already replanned` })
    return false
  }
  const leg = plan.legs.find((l) => l.seq === row.leg_seq)!
  const trains = TRAINS.filter((t) => t.from === leg.fromYard && t.to === leg.toYard).map((t) => t.trainId)
  const readyAt = Math.max(row.ready_at.getTime(), nowMs())
  const seat = await reserveFirstRun(tx, trains, readyAt, row.trip_id, `saga:${row.saga_id}`, config.replanner.horizonHours, new Set([row.missed_run_id]))
  if (!seat) {
    const reason = `No train ${leg.fromYard}→${leg.toYard} with capacity within ${config.replanner.horizonHours} h of ${new Date(readyAt).toISOString().slice(0, 16)}`
    await append(tx, { type: 'ReplanFailed', ...meta(row, row.trigger_event_id), dedupeKey: `rpf:${row.saga_id}`, payload: { sagaId: row.saga_id, carId: row.car_id, tripId: row.trip_id, shipperId: row.shipper_id, reason, yardId: row.yard_id } })
    await transition(tx, row, 'failed', 'reserve', { reason }, { error: reason })
    return false
  }
  const reserved = await append(tx, {
    type: 'TrainCapacityReserved',
    ...meta(row, row.trigger_event_id),
    dedupeKey: `tcr:${row.saga_id}:${seat.runId}`,
    payload: { sagaId: row.saga_id, carId: row.car_id, tripId: row.trip_id, runId: seat.runId, trainId: seat.trainId, departure: seat.departure },
  })
  await transition(tx, row, 'reserved', 'reserve', { runId: seat.runId, departure: seat.departure, eventId: reserved.eventId }, { chosen_run_id: seat.runId })
  return true
}

/** Releases what this saga booked on `runId` and records the compensation. */
async function compensate(tx: PoolClient, row: SagaRow, runId: string, reason: string, causationId: string | null): Promise<void> {
  await tx.query("DELETE FROM run_reservations WHERE run_id = $1 AND trip_id = $2 AND reserved_by = $3", [runId, row.trip_id, `saga:${row.saga_id}`])
  await append(tx, { type: 'TrainCapacityReleased', ...meta(row, causationId), dedupeKey: `tcx:${row.saga_id}:${runId}`, payload: { sagaId: row.saga_id, carId: row.car_id, tripId: row.trip_id, runId, reason } })
  await append(tx, { type: 'ReplanCompensated', ...meta(row, causationId), dedupeKey: `rpc:${row.saga_id}`, payload: { sagaId: row.saga_id, carId: row.car_id, tripId: row.trip_id, reason, releasedRunId: runId } })
  await transition(tx, row, 'compensated', 'compensate', { runId, reason })
}

function reasonText(row: SagaRow, leg: Leg, chosen: string): string {
  switch (row.trigger_type) {
    case 'inbound_delay':
      return `Inbound train late into ${leg.fromYard}; cannot make ${leg.runId}. Moved to ${chosen}.`
    case 'departed_without_car':
      return `${leg.runId} left ${leg.fromYard} without the car. Moved to ${chosen}.`
    default:
      return `${leg.runId} was cancelled. Moved to ${chosen}.`
  }
}

/** Step 2: write the new plan version (optimistic concurrency against the version the saga started from). */
async function reviseStep(tx: PoolClient, row: SagaRow): Promise<boolean> {
  const plan = await loadPlan(tx, row.trip_id)
  if (!plan || plan.version !== row.from_plan_version) {
    await compensate(tx, row, row.chosen_run_id!, `plan moved to v${plan?.version} before this saga could revise it`, null)
    return false
  }
  const { rows } = await tx.query<{ train_id: string; scheduled_departure: Date; scheduled_arrival: Date }>(
    'SELECT train_id, scheduled_departure, scheduled_arrival FROM train_runs WHERE run_id = $1',
    [row.chosen_run_id],
  )
  const run = rows[0]
  const old = plan.legs.find((l) => l.seq === row.leg_seq)!
  const replaced: Leg = { ...old, trainId: run.train_id, runId: row.chosen_run_id!, plannedDeparture: run.scheduled_departure.toISOString(), plannedArrival: run.scheduled_arrival.toISOString() }
  const later = plan.legs.filter((l) => l.seq > row.leg_seq)
  let tail: Leg[] = []
  if (later.length) {
    const ready = run.scheduled_arrival.getTime() + (yardById.get(replaced.toYard)?.minConnectionMinutes ?? 240) * 60_000
    const planned = await planLegs(tx, later.map((l) => l.trainId), ready, row.trip_id, `saga:${row.saga_id}`, row.leg_seq + 1, config.replanner.horizonHours)
    if (!planned) {
      await compensate(tx, row, row.chosen_run_id!, 'no capacity for the onward legs', null)
      return false
    }
    tail = planned
  }
  const legs = [...plan.legs.filter((l) => l.seq < row.leg_seq), replaced, ...tail]
  try {
    const revision = await revisePlan(tx, plan, {
      tripId: row.trip_id,
      expectedVersion: row.from_plan_version,
      legs,
      reason: { code: row.trigger_type === 'train_cancelled' ? 'train_cancelled' : 'missed_connection', text: reasonText(row, old, row.chosen_run_id!), missedRunId: old.runId, yardId: old.fromYard },
      revisedBy: 'replanner',
      sagaId: row.saga_id,
      producer: 'svc:replanner',
      correlationId: row.correlation_id,
      causationId: row.trigger_event_id,
    })
    await transition(tx, row, 'awaiting_eta', 'revise', { version: revision.version, eventId: revision.eventId }, { revision_event_id: revision.eventId, to_plan_version: revision.version })
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) throw err
    await compensate(tx, row, row.chosen_run_id!, `plan revised concurrently (now v${err.actual})`, null)
  }
  return false
}

/** Runs the saga forward until it waits on something outside it. Safe to call repeatedly. */
export async function advance(sagaId: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const progressed = await withTransaction(async (tx) => {
      const row = await lockSaga(tx, sagaId)
      if (!row) return false
      if (row.state === 'started') return reserveStep(tx, row)
      if (row.state === 'reserved') return reviseStep(tx, row)
      return false
    })
    if (!progressed) return
  }
}

/** Step 3: the ETA service answered our revision; record the outcome for the shipper digest. */
export async function onEtaUpdated(tx: PoolClient, e: EventEnvelope<'EtaUpdated'>): Promise<void> {
  if (!e.causationId) return
  const { rows } = await tx.query<SagaRow>("SELECT * FROM replan_sagas WHERE revision_event_id = $1 AND state = 'awaiting_eta' FOR UPDATE", [e.causationId])
  const row = rows[0]
  if (!row) return
  await complete(tx, row, { p10: e.payload.p10, p50: e.payload.p50, p90: e.payload.p90 }, e.eventId)
}

async function complete(tx: PoolClient, row: SagaRow, etaAfter: { p10: string; p50: string; p90: string } | null, causationId: string | null): Promise<void> {
  const shift = etaAfter && row.eta_before ? Math.round((Date.parse(etaAfter.p50) - Date.parse(row.eta_before.p50)) / 60_000) : null
  const plan = await loadPlan(tx, row.trip_id)
  const version = plan?.versions.find((v) => v.version === row.to_plan_version)
  await append(tx, {
    type: 'ReplanCompleted',
    ...meta(row, causationId),
    dedupeKey: `rpd:${row.saga_id}`,
    payload: {
      sagaId: row.saga_id, carId: row.car_id, tripId: row.trip_id, shipperId: row.shipper_id, fromPlanVersion: row.from_plan_version,
      toPlanVersion: row.to_plan_version ?? row.from_plan_version + 1, chosenRunId: row.chosen_run_id!, etaBefore: row.eta_before, etaAfter, shiftMinutes: shift,
      reasonText: version?.reasonText ?? 'Replanned',
    },
  })
  await transition(tx, row, 'completed', 'complete', { etaAfter, shiftMinutes: shift }, { eta_after: etaAfter ? JSON.stringify(etaAfter) : null })
}

/**
 * A cancelled train: compensate every saga that chose it (release the seat, start a child saga), and start
 * a saga for every other car whose current plan uses it. Returns the saga ids to advance after commit.
 */
export async function onTrainCancelled(tx: PoolClient, e: EventEnvelope<'TrainCancelled'>): Promise<string[]> {
  const runId = e.payload.runId
  const started: string[] = []
  const { rows: chose } = await tx.query<SagaRow>(
    "SELECT * FROM replan_sagas WHERE chosen_run_id = $1 AND state IN ('reserved', 'awaiting_eta', 'completed') ORDER BY saga_id FOR UPDATE",
    [runId],
  )
  const compensatedTrips = new Map<string, SagaRow>()
  for (const row of chose) {
    const before = row.state
    await compensate(tx, row, runId, `chosen train ${runId} cancelled: ${e.payload.reason}`, e.eventId)
    compensatedTrips.set(row.trip_id, row)
    if (before === 'reserved') {
      // The plan was never revised, so the original miss is still open: retry it as the next attempt.
      const id = await startSaga(tx, {
        tripId: row.trip_id, carId: row.car_id, shipperId: row.shipper_id, trigger: row.trigger_type, cause: e, fromPlanVersion: row.from_plan_version,
        legSeq: row.leg_seq, yardId: row.yard_id, missedRunId: row.missed_run_id, readyAt: row.ready_at.toISOString(), attempt: row.attempt + 1, parentSagaId: row.saga_id,
      })
      if (id) started.push(id)
    }
  }
  const { rows: planned } = await tx.query<{ trip_id: string; car_id: string; shipper_id: string; plan_version: number; leg_seq: number; from_yard: string }>(
    `SELECT pl.trip_id, pl.car_id, tp.shipper_id, pl.plan_version, pl.leg_seq, pl.from_yard
       FROM plan_legs_current pl JOIN trip_plans tp USING (trip_id) WHERE pl.run_id = $1 ORDER BY pl.trip_id`,
    [runId],
  )
  for (const p of planned) {
    const parent = compensatedTrips.get(p.trip_id)
    const plan = await loadPlan(tx, p.trip_id)
    const prev = plan?.legs.find((l) => l.seq === p.leg_seq - 1)
    const minConn = (yardById.get(p.from_yard)?.minConnectionMinutes ?? 240) * 60_000
    const readyAt = Math.max(nowMs(), parent ? parent.ready_at.getTime() : prev ? Date.parse(prev.plannedArrival) + minConn : nowMs())
    const id = await startSaga(tx, {
      tripId: p.trip_id, carId: p.car_id, shipperId: p.shipper_id, trigger: 'train_cancelled', cause: e, fromPlanVersion: p.plan_version, legSeq: p.leg_seq,
      yardId: p.from_yard, missedRunId: runId, readyAt: new Date(readyAt).toISOString(), attempt: parent ? parent.attempt + 1 : 1, parentSagaId: parent?.saga_id ?? null,
    })
    if (id) started.push(id)
  }
  return started
}

/** Resumes sagas a crash left between steps, and completes sagas whose ETA reply never came. */
export async function sweepSagas(): Promise<void> {
  const { rows } = await (await import('../shared/db.js')).pool.query<{ saga_id: string; state: SagaState }>(
    `SELECT saga_id, state FROM replan_sagas
      WHERE (state IN ('started', 'reserved') AND updated_at < now() - make_interval(secs => $1))
         OR (state = 'awaiting_eta' AND updated_at < now() - make_interval(secs => $2))
      ORDER BY updated_at LIMIT 100`,
    [config.replanner.stuckAfterMs / 1000, config.replanner.etaTimeoutMs / 1000],
  )
  for (const r of rows) {
    if (r.state === 'awaiting_eta') {
      await withTransaction(async (tx) => {
        const row = await lockSaga(tx, r.saga_id)
        if (!row || row.state !== 'awaiting_eta') return
        const { rows: eta } = await tx.query<{ p10: Date; p50: Date; p90: Date }>('SELECT p10, p50, p90 FROM car_eta WHERE car_id = $1', [row.car_id])
        const after = eta[0] ? { p10: eta[0].p10.toISOString(), p50: eta[0].p50.toISOString(), p90: eta[0].p90.toISOString() } : null
        await complete(tx, row, after, null)
      })
    } else {
      logger.warn({ sagaId: r.saga_id, state: r.state }, 'resuming stuck saga')
      await advance(r.saga_id)
    }
  }
}
