/**
 * The line: desks, subdivisions, yards, detectors with health, and coverage gaps.
 */
import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { laneKey, type Lane } from '../../shared/stream.js'
import { config } from '../../shared/config.js'
import { clockInfo } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { DESKS, SUBDIVISIONS, YARDS } from '../../shared/network.js'
import { loadThresholds } from '../../shared/thresholds.js'
import { coverageGaps } from '../services/coverage.js'

export const networkRouter = Router()
networkRouter.use(requireAuth)

/**
 * What operators should assume about a detector's data right now:
 *  live         data is arriving and processed promptly
 *  delayed      the gateway is offline; passes are buffered at the site and will arrive late
 *  catching_up  a backlog arrived and is being processed in the backfill lane
 *  gap          the detector is silent; nothing is coming, so this stretch is uncovered
 */
export function coverageState(status: string, pendingPasses: number): 'live' | 'delayed' | 'catching_up' | 'gap' {
  if (status === 'silent') return 'gap'
  if (status === 'offline') return 'delayed'
  if (pendingPasses > 0) return 'catching_up'
  return 'live'
}

const detectorDto = (d: Record<string, unknown>) => ({
  id: d.id, name: d.name, milepost: d.milepost, subdivisionId: d.subdivision_id, hasAei: d.has_aei, brakingZone: d.braking_zone, gatewayId: d.gateway_id,
  status: d.status, statusReason: d.status_reason, statusSince: d.status_since, lastHeardAt: d.last_heard_at, lastPassAt: d.last_pass_at,
  bufferedPasses: d.buffered_passes, selfTest: d.self_test, biasOffsetF: d.bias_offset_f, biasSamples: d.bias_samples, missedPasses: d.missed_passes,
  pendingPasses: d.pending_passes ?? 0, lastReceivedAt: d.last_received_at ?? null,
  coverage: coverageState(String(d.status), Number(d.pending_passes ?? 0)),
})

/** Readings not yet handled by the analyzer group, per lane (Valkey 7 reports consumer-group lag). */
async function laneBacklog(): Promise<Record<Lane, number | null>> {
  const out: Record<Lane, number | null> = { live: null, backfill: null }
  for (const lane of ['live', 'backfill'] as Lane[]) {
    try {
      const groups = (await redis.xinfo('GROUPS', laneKey(lane))) as unknown[][]
      const fields = groups.find((g) => g[g.indexOf('name') + 1] === 'analyzer') ?? []
      const get = (name: string) => Number(fields[fields.indexOf(name) + 1] ?? 0)
      out[lane] = get('lag') + get('pending')
    } catch {
      out[lane] = null
    }
  }
  return out
}

networkRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { config: t } = await loadThresholds()
    const { rows } = await pool.query(
      `SELECT d.*, COALESCE(h.status, 'ok') AS status, h.status_reason, h.status_since, h.last_received_at,
              (SELECT count(*)::int FROM detector_passes p WHERE p.detector_id = d.id AND p.processed_at IS NULL AND p.identity_status <> 'awaiting_consist') AS pending_passes
         FROM detectors d LEFT JOIN detector_health h ON h.detector_id = d.id ORDER BY milepost`,
    )
    const detectors = rows.map(detectorDto)
    res.json({
      desks: DESKS,
      subdivisions: SUBDIVISIONS.map((s) => ({ ...s, endMp: Math.floor(s.endMp) })),
      yards: YARDS,
      detectors,
      coverageGaps: coverageGaps(rows.map((d) => ({ id: d.id, milepost: d.milepost, status: d.status })), 0, 240, t.maxDetectorSpacingMiles),
      maxSpacingMiles: t.maxDetectorSpacingMiles,
      lanes: await laneBacklog(),
      clock: clockInfo(),
    })
  }),
)

networkRouter.get(
  '/detectors/:id',
  asyncHandler(async (req, res) => {
    const d = (
      await pool.query(
        `SELECT d.*, COALESCE(h.status, 'ok') AS status, h.status_reason, h.status_since, h.last_received_at
           FROM detectors d LEFT JOIN detector_health h ON h.detector_id = d.id WHERE d.id = $1`,
        [req.params.id],
      )
    ).rows[0]
    if (!d) throw notFound('Detector')
    const [passes, samples, missed] = await Promise.all([
      pool.query(
        `SELECT p.pass_id, p.trip_id, t.symbol, p.passed_at, p.lag_seconds, p.ambient_f,
                (p.median_bearing_n + p.median_bearing_s) / 2 - p.ambient_f AS median_above
           FROM detector_passes p LEFT JOIN trips t ON t.trip_id = p.trip_id WHERE p.detector_id = $1 ORDER BY p.passed_at DESC LIMIT 10`,
        [d.id],
      ),
      pool.query('SELECT trip_id, sample_f, sampled_at FROM detector_bias_samples WHERE detector_id = $1 ORDER BY sampled_at DESC LIMIT 8', [d.id]),
      pool.query(
        `SELECT e.trip_id, t.symbol, e.noted_at FROM expected_passes e JOIN trips t ON t.trip_id = e.trip_id
          WHERE e.detector_id = $1 AND e.status = 'missing' ORDER BY e.noted_at DESC LIMIT 10`,
        [d.id],
      ),
    ])
    res.json({
      detector: detectorDto(d),
      recentPasses: passes.rows.map((p) => ({
        passId: p.pass_id, tripId: p.trip_id, symbol: p.symbol, passedAt: p.passed_at, lagSeconds: p.lag_seconds,
        late: p.lag_seconds > config.analysis.lateAfterMinutes * 60, medianAboveAmbient: p.median_above === null ? null : Math.round(p.median_above),
      })),
      biasSamples: samples.rows.map((s) => ({ tripId: s.trip_id, sampleF: s.sample_f, sampledAt: s.sampled_at })),
      missedTrains: missed.rows.map((m) => ({ tripId: m.trip_id, symbol: m.symbol, notedAt: m.noted_at })),
      clock: clockInfo(),
    })
  }),
)
