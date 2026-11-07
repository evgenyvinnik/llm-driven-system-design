/**
 * detector-health projection: detector_health from DetectorHealthChanged (the
 * decided status, one ordered stream) and PassRecorded (freshness counters).
 * Counters are commutative and processed-events makes each pass count once, so
 * the two streams can be consumed in any interleaving.
 * @module workers/projections/detector-health
 */
import type { Queryable } from '../../shared/db.js'
import type { LiveEvent } from '../../shared/events.js'
import type { EventEnvelope } from '../../events/envelope.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export async function applyDetectorHealth(db: Queryable, e: EventEnvelope): Promise<LiveEvent[]> {
  const p = e.payload as P
  if (e.type === 'PassRecorded') {
    const late = p.lane === 'backfill' ? 1 : 0
    await db.query(
      `INSERT INTO detector_health (detector_id, last_pass_at, last_received_at, passes, late_passes, max_lag_seconds) VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (detector_id) DO UPDATE SET last_pass_at = GREATEST(detector_health.last_pass_at, EXCLUDED.last_pass_at),
         last_received_at = GREATEST(detector_health.last_received_at, EXCLUDED.last_received_at), passes = detector_health.passes + 1,
         late_passes = detector_health.late_passes + EXCLUDED.late_passes, max_lag_seconds = GREATEST(detector_health.max_lag_seconds, EXCLUDED.max_lag_seconds)`,
      [p.detectorId, p.passedAt, p.receivedAt, late, p.lagSeconds],
    )
    return []
  }
  if (e.type === 'DetectorHealthChanged') {
    await db.query(
      `INSERT INTO detector_health (detector_id, status, status_reason, status_since) VALUES ($1, $2, $3, $4)
       ON CONFLICT (detector_id) DO UPDATE SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason, status_since = EXCLUDED.status_since`,
      [p.detectorId, p.to, p.reason, e.occurredAt],
    )
    return [{ type: 'detector.updated' }]
  }
  return []
}
