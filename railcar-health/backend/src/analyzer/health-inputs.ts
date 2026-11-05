/**
 * Detector-health inputs written while processing a pass: which detectors the
 * trip should have passed (so silence is visible), and a bias sample for every
 * detector on the trip whose neighbours also saw the same train.
 * @module analyzer/health-inputs
 */
import type pg from 'pg'
import type { Direction, Thresholds } from '../shared/domain.js'
import { DETECTORS, yardById } from '../shared/network.js'
import { biasEstimate, biasSample, detectorsOnRoute, expectedPassStatuses } from './detector-health.js'

const NEIGHBOUR_WINDOW_MILES = 35
const MISSED_WINDOW_MS = 24 * 3_600_000

interface TripLike {
  trip_id: string
  direction: Direction
  origin_yard_id: string
  destination_yard_id: string
}

export async function updateDetectorInputs(
  client: pg.PoolClient,
  trip: TripLike,
  pass: { detector_id: string; passed_at: Date },
  nowMs: number,
  t: Thresholds,
): Promise<void> {
  const now = new Date(nowMs)
  await client.query('UPDATE detectors SET last_pass_at = GREATEST(COALESCE(last_pass_at, $2), $2) WHERE id = $1', [pass.detector_id, pass.passed_at])

  // Expected passes: recomputed from every detector this trip has been seen at, in any order.
  const route = detectorsOnRoute(DETECTORS, trip.direction, yardById(trip.origin_yard_id)!.milepost, yardById(trip.destination_yard_id)!.milepost)
  const observed = new Set(
    (await client.query<{ detector_id: string }>('SELECT DISTINCT detector_id FROM detector_passes WHERE trip_id = $1', [trip.trip_id])).rows.map((r) => r.detector_id),
  )
  const statuses = expectedPassStatuses(route, observed)
  if (statuses.length > 0) {
    await client.query(
      `INSERT INTO expected_passes (trip_id, detector_id, status, noted_at)
       SELECT $1, s.detector_id, s.status, $4 FROM unnest($2::text[], $3::text[]) AS s(detector_id, status)
       ON CONFLICT (trip_id, detector_id) DO UPDATE SET status = EXCLUDED.status,
         noted_at = CASE WHEN expected_passes.status = EXCLUDED.status THEN expected_passes.noted_at ELSE EXCLUDED.noted_at END`,
      [trip.trip_id, statuses.map((s) => s.detectorId), statuses.map((s) => s.status), now],
    )
    await client.query(
      `UPDATE detectors d SET missed_passes = (
          SELECT count(*) FROM expected_passes e WHERE e.detector_id = d.id AND e.status = 'missing' AND e.noted_at > $2)
        WHERE d.id = ANY($1)`,
      [statuses.map((s) => s.detectorId), new Date(nowMs - MISSED_WINDOW_MS)],
    )
  }

  // Bias samples: each detector's train median vs its nearest neighbours on the same train.
  const { rows } = await client.query<{ detector_id: string; milepost: number; median_above: number | null; passed_at: Date; bias_offset_f: number | null; bias_samples: number }>(
    `SELECT p.detector_id, d.milepost, (p.median_bearing_n + p.median_bearing_s) / 2 - p.ambient_f AS median_above, p.passed_at,
            d.bias_offset_f, d.bias_samples
       FROM detector_passes p JOIN detectors d ON d.id = p.detector_id
      WHERE p.trip_id = $1 AND p.identity_status = 'resolved' AND p.median_bearing_n IS NOT NULL`,
    [trip.trip_id],
  )
  const flagged = (r: (typeof rows)[number]) => r.bias_offset_f !== null && r.bias_samples >= t.biasMinSamples && Math.abs(r.bias_offset_f) >= t.biasAlarmF
  // A flagged neighbour is used with its known offset removed, so one bad detector doesn't smear onto the next.
  const reference = (r: (typeof rows)[number]) => (r.median_above ?? 0) - (flagged(r) ? r.bias_offset_f! : 0)
  const sorted = [...rows].sort((a, b) => a.milepost - b.milepost)
  const touched: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const center = sorted[i]
    const left = sorted.slice(0, i).reverse().find((r) => center.milepost - r.milepost <= NEIGHBOUR_WINDOW_MILES)
    const right = sorted.slice(i + 1).find((r) => r.milepost - center.milepost <= NEIGHBOUR_WINDOW_MILES)
    const sample = biasSample(center.median_above ?? 0, left ? reference(left) : null, right ? reference(right) : null)
    if (sample === null) continue
    await client.query(
      `INSERT INTO detector_bias_samples (detector_id, trip_id, sample_f, sampled_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (detector_id, trip_id) DO UPDATE SET sample_f = EXCLUDED.sample_f`,
      [center.detector_id, trip.trip_id, Math.round(sample * 100) / 100, center.passed_at],
    )
    touched.push(center.detector_id)
  }
  for (const detectorId of touched) {
    const samples = (
      await client.query<{ sample_f: number }>(
        'SELECT sample_f FROM (SELECT sample_f, sampled_at FROM detector_bias_samples WHERE detector_id = $1 ORDER BY sampled_at DESC LIMIT 8) s ORDER BY sampled_at',
        [detectorId],
      )
    ).rows.map((r) => r.sample_f)
    const estimate = biasEstimate(samples, t.biasAlarmF, t.biasMinSamples)
    await client.query('UPDATE detectors SET bias_offset_f = $2, bias_samples = $3 WHERE id = $1', [
      detectorId,
      estimate.offset === null ? null : Math.round(estimate.offset * 10) / 10,
      estimate.n,
    ])
  }
}
