/**
 * The car_state projection writer, shared by the live consumer and replay (which passes a shadow table).
 * @module consumers/car-state/projection
 */
import type { Queryable } from '../../shared/db.js'
import { foldCar, type CarState } from '../../domain/car-fold.js'
import { loadCarTimeline } from '../../shared/event-store.js'
import { config } from '../../shared/config.js'

export const CAR_STATE_COLUMNS = [
  'car_id', 'trip_id', 'shipper_id', 'plan_version', 'status', 'location_id', 'train_run_id', 'position_confidence', 'position_source',
  'last_observed_at', 'last_event_at', 'arrived_at', 'current_leg', 'plan_status', 'missed_reads', 'late_events', 'out_of_order_events',
  'event_count', 'foreign_road',
]

export async function writeCarState(q: Queryable, s: CarState, table = 'car_state'): Promise<void> {
  const values = [
    s.carId, s.plan?.tripId ?? null, s.plan?.shipperId ?? null, s.plan?.version ?? null, s.status, s.locationId, s.trainRunId, s.positionConfidence,
    s.positionSource, s.lastObservedAt, s.lastEventAt, s.arrivedAt, s.currentLeg, s.planStatus, s.missedReads, s.lateEvents, s.outOfOrderEvents,
    s.eventCount, s.foreignRoad,
  ]
  const cols = CAR_STATE_COLUMNS.join(', ')
  const params = CAR_STATE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')
  const updates = CAR_STATE_COLUMNS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')
  await q.query(`INSERT INTO ${table} (${cols}, updated_at) VALUES (${params}, now()) ON CONFLICT (car_id) DO UPDATE SET ${updates}, updated_at = now()`, values)
}

/** Folds one car's timeline (optionally up to a log position) and writes the row. */
export async function refreshCar(q: Queryable, carId: string, table = 'car_state', upTo?: number): Promise<CarState> {
  const timeline = await loadCarTimeline(q, carId, upTo)
  const state = foldCar(carId, timeline, { lateAfterMinutes: config.lateAfterMinutes })
  await writeCarState(q, state, table)
  return state
}
