/**
 * car-history projection: component_installs (from ComponentReplaced on the car
 * streams) and car_trips (from CarIdentified on the identity stream).
 *
 * Event time drives the install timeline: installed_at is when the wheelset went
 * on the car, recorded_at when we were told. The previous wheelset on the axle is
 * closed at the new one's installed_at, whatever order the facts arrived in.
 * @module workers/projections/car-history
 */
import type { Queryable } from '../../shared/db.js'
import type { LiveEvent } from '../../shared/events.js'
import type { EventEnvelope } from '../../events/envelope.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export async function applyCarHistory(db: Queryable, e: EventEnvelope): Promise<LiveEvent[]> {
  const p = e.payload as P
  if (e.type === 'ComponentReplaced') {
    await db.query(
      `UPDATE component_installs SET removed_at = $3 WHERE car_id = $1 AND axle = $2 AND installed_at < $3 AND (removed_at IS NULL OR removed_at > $3)`,
      [p.carId, p.axle, p.installedAt],
    )
    // A later install already recorded (an out-of-order fact) bounds this one.
    await db.query(
      `INSERT INTO component_installs (car_id, axle, component_id, installed_at, removed_at, recorded_at, recorded_by, finding_id, event_id)
       VALUES ($1, $2, $3, $4, (SELECT min(installed_at) FROM component_installs WHERE car_id = $1 AND axle = $2 AND installed_at > $4), $5, $6, $7, $8)
       ON CONFLICT (car_id, axle, installed_at) DO NOTHING`,
      [p.carId, p.axle, p.installedComponentId, p.installedAt, e.recordedAt, p.recordedBy, p.findingId, e.eventId],
    )
    return [{ type: 'trip.updated', carId: p.carId }]
  }
  if (e.type === 'CarIdentified') {
    await db.query(
      `INSERT INTO car_trips (trip_id, car_id, revision, position, leading_end, orientation_source, corrected_by_detector, identified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (trip_id, car_id) DO UPDATE SET revision = EXCLUDED.revision, position = EXCLUDED.position, leading_end = EXCLUDED.leading_end,
         orientation_source = EXCLUDED.orientation_source, corrected_by_detector = COALESCE(EXCLUDED.corrected_by_detector, car_trips.corrected_by_detector),
         identified_at = EXCLUDED.identified_at`,
      [p.tripId, p.carId, p.revision, p.position, p.leadingEnd, p.source, p.source === 'aei' ? p.detectorId : null, e.occurredAt],
    )
    return []
  }
  return []
}
