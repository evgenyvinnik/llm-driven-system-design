/**
 * Which cars an event concerns. Car-topic events name their car (the partition key). A train event concerns
 * every car in that run's consist and every car whose current plan uses the run: this is where one train
 * event fans out to 100 car updates inside a single consumer (the hot-key cost of keying trains by run).
 * @module consumers/affected
 */
import type { Queryable } from '../shared/db.js'
import type { AnyEnvelope } from '../shared/events/envelope.js'
import type { EventType } from '../shared/events/schemas.js'

export const CAR_FACTS: EventType[] = ['CarSighted', 'CarArrivedYard', 'CarDepartedYard', 'CarPlaced', 'CarPulled', 'CarBadOrdered', 'CarInterchanged']
export const TRAIN_FACTS: EventType[] = ['TrainDeparted', 'TrainArrived', 'TrainDelayed', 'TrainCancelled']

export async function affectedCars(q: Queryable, e: AnyEnvelope): Promise<string[]> {
  if (e.topic === 'car') return [e.partitionKey]
  if (e.type === 'ClockTicked') {
    // Time passing can move every ETA that is not final yet.
    const { rows } = await q.query<{ car_id: string }>('SELECT car_id FROM car_eta WHERE NOT final ORDER BY car_id')
    return rows.map((r) => r.car_id)
  }
  if (e.topic !== 'train') return []
  const runId = (e.payload as { runId: string }).runId
  const consist = e.type === 'TrainDeparted' ? e.payload.consist : []
  const { rows } = await q.query<{ car_id: string }>(
    `SELECT car_id FROM train_run_cars WHERE run_id = $1
     UNION SELECT car_id FROM plan_legs_current WHERE run_id = $1`,
    [runId],
  )
  return [...new Set([...consist, ...rows.map((r) => r.car_id)])].sort()
}
