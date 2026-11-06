/**
 * Consumer group `eta`: recomputes a car's p10/p50/p90 ETA whenever an event that can move it arrives
 * (a car fact, a plan change, or a departure, arrival, delay or cancellation of a train it rides or is
 * planned on), writes the car_eta projection and the eta_history audit row, and emits EtaUpdated when the
 * median moves materially or the plan version changed.
 *
 * It reads the event store, not another consumer's projection: the car's state comes from the same pure fold
 * car-state uses, so the two consumers never wait on each other and each can be replayed alone.
 * @module consumers/eta/handler
 */
import { randomUUID } from 'node:crypto'
import type { Queryable } from '../../shared/db.js'
import { foldCar, type CarState } from '../../domain/car-fold.js'
import { computeEta, type EtaResult } from '../../domain/eta-model.js'
import { config } from '../../shared/config.js'
import { append, fieldWatermark, latestTick, loadCarTimeline } from '../../shared/event-store.js'
import { withTransaction } from '../../shared/db.js'
import { causedBy, type AnyEnvelope } from '../../shared/events/envelope.js'
import type { EventType } from '../../shared/events/schemas.js'
import type { HandlerContext } from '../../shared/consumer.js'
import { affectedCars, CAR_FACTS, TRAIN_FACTS } from '../affected.js'
import { nowMs } from '../../shared/clock.js'

export const ETA_TYPES: EventType[] = [...CAR_FACTS, ...TRAIN_FACTS, 'TripPlanCreated', 'TripPlanRevised', 'ClockTicked']

export async function writeCarEta(q: Queryable, s: CarState, eta: EtaResult, table = 'car_eta'): Promise<void> {
  await q.query(
    `INSERT INTO ${table} (car_id, trip_id, plan_version, p10, p50, p90, confidence, as_of, final, basis, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (car_id) DO UPDATE SET trip_id = EXCLUDED.trip_id, plan_version = EXCLUDED.plan_version, p10 = EXCLUDED.p10,
       p50 = EXCLUDED.p50, p90 = EXCLUDED.p90, confidence = EXCLUDED.confidence, as_of = EXCLUDED.as_of, final = EXCLUDED.final,
       basis = EXCLUDED.basis, updated_at = now()`,
    [s.carId, s.plan!.tripId, s.plan!.version, eta.p10, eta.p50, eta.p90, eta.confidence, eta.asOf, eta.final, JSON.stringify(eta.basis)],
  )
}

/** Folds the car and computes its ETA from the log alone (used live and by replay). */
export async function etaFromLog(q: Queryable, carId: string, upTo?: number): Promise<{ state: CarState; eta: EtaResult | null }> {
  const state = foldCar(carId, await loadCarTimeline(q, carId, upTo), { lateAfterMinutes: config.lateAfterMinutes })
  return { state, eta: state.plan ? computeEta(state, config.eta.samples, await latestTick(q, upTo)) : null }
}

/**
 * Appends ClockTicked when the event-time watermark crosses a tick boundary. The clock is the watermark,
 * not the wall: it advances when the field reports newer events, so compressed (simulated) time and replays
 * behave exactly like live time.
 */
export async function emitClockTick(): Promise<string | null> {
  return withTransaction(async (tx) => {
    const wm = await fieldWatermark(tx)
    if (!wm) return null
    const period = config.eta.clockTickMinutes * 60_000
    const at = new Date(Math.floor(wm.getTime() / period) * period).toISOString()
    const last = await latestTick(tx)
    if (last && last >= at) return null
    const res = await append(tx, { type: 'ClockTicked', occurredAt: at, producer: 'svc:clock', dedupeKey: `tick:${at}`, payload: { at, watermark: wm.toISOString() } })
    return res.status === 'appended' ? at : null
  })
}

export async function handleEta(e: AnyEnvelope, ctx: HandlerContext): Promise<void> {
  const { tx } = ctx
  for (const carId of await affectedCars(tx, e)) {
    const { state, eta } = await etaFromLog(tx, carId)
    if (!eta || !state.plan) continue
    const { rows } = await tx.query<{ p50: Date; plan_version: number; final: boolean }>('SELECT p50, plan_version, final FROM car_eta WHERE car_id = $1', [carId])
    const prev = rows[0]
    await writeCarEta(tx, state, eta)
    await tx.query(
      `INSERT INTO eta_history (car_id, trip_id, plan_version, p10, p50, p90, as_of, trigger_event_id, trigger_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [carId, state.plan.tripId, state.plan.version, eta.p10, eta.p50, eta.p90, eta.asOf, e.eventId, e.type],
    )
    const shift = prev ? Math.round((Date.parse(eta.p50) - prev.p50.getTime()) / 60_000) : null
    const material =
      !prev || prev.plan_version !== state.plan.version || Math.abs(shift ?? 0) >= config.eta.materialShiftMinutes || (eta.final && !prev.final)
    // The replanner waits for the ETA caused by its plan revision, so a revision always gets a reply.
    if (!material && e.type !== 'TripPlanRevised') continue
    await append(tx, {
      eventId: randomUUID(),
      type: 'EtaUpdated',
      occurredAt: new Date(Math.max(nowMs(), Date.parse(e.occurredAt))).toISOString(),
      producer: 'svc:eta',
      ...causedBy(e),
      dedupeKey: `eta:${carId}:${e.eventId}`,
      payload: {
        carId,
        tripId: state.plan.tripId,
        shipperId: state.plan.shipperId,
        planVersion: state.plan.version,
        p10: eta.p10,
        p50: eta.p50,
        p90: eta.p90,
        previousP50: prev ? prev.p50.toISOString() : null,
        shiftMinutes: shift,
        confidence: eta.confidence,
        asOf: eta.asOf,
        trigger: e.type,
        final: eta.final,
      },
    })
  }
}
