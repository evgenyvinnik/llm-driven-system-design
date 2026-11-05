/**
 * processPass: everything the analyzer does for one detector pass, in one
 * PostgreSQL transaction under a per-trip advisory lock (the local stand-in for
 * "partition by trip gives each trip a single writer").
 *
 *   1. Skip if already processed (redelivery after a crash between commit and ack).
 *   2. Resolve identity: consist + AEI corrections -> car, car-relative position.
 *   3. Recompute trend features for every bearing on the train from all its
 *      observations in this trip (order-independent), and score them.
 *   4. Open, escalate or refresh alerts; holds and work orders at MEDIUM+.
 *   5. Update the trip's position, territory and next yard; detector health inputs.
 *   6. Mark processed. The caller publishes live events and acks after commit.
 * @module analyzer/pipeline
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import type { AlertKind, Direction, Rail, Thresholds } from '../shared/domain.js'
import type { LiveEvent } from '../shared/events.js'
import { nowMs as clockNow } from '../shared/clock.js'
import { subdivisionAt, yardById, YARDS } from '../shared/network.js'
import { loadThresholds } from '../shared/thresholds.js'
import { alertKey, applyCandidates, closeOrphans, type Candidate, type ExistingRow, type Transition } from './alert-manager.js'
import { axleKey, currentInstalls, splitByInstall, type InstallCutoffs } from './components.js'
import { decideIdentity } from './identity.js'
import { loadUnits, persistCorrections, reresolveTrip, resolvePassReadings, revisionAt } from './resolve.js'
import { scoreBearing, scoreColdWheel, scoreHotWheel, scoreOverHistory, type Score } from './risk.js'
import { estimateMilepost, predictNextYard, type TripState } from './routing.js'
import { buildObservations, edgeAlarmKey, passMedians, type BearingFeatures, type PassContext, type PassMedians, type ReadingRow } from './trend.js'
import { updateDetectorInputs } from './health-inputs.js'

/** Wheel alerts cover the whole car. */
export const WHEEL_POSITION = 'CAR'

export type Outcome = 'processed' | 'already_processed' | 'missing' | 'awaiting_consist' | 'unresolved'

export interface ProcessResult {
  outcome: Outcome
  events: LiveEvent[]
  transitions: Transition[]
  corrections: number
  /** Readings measured before the current wheelset was installed: kept, but not used as evidence. */
  excludedPreInstall: number
}

interface PassRow {
  detector_id: string
  pass_id: string
  trip_id: string
  direction: Direction
  passed_at: Date
  lag_seconds: number
  speed_mph: number
  axle_count: number
  aei: Array<{ position: number; unitId: string; leadingEnd: 'A' | 'B' }> | null
  processed_at: Date | null
  milepost: number
}

interface TripRow {
  trip_id: string
  symbol: string
  direction: Direction
  origin_yard_id: string
  destination_yard_id: string
  stops: string[]
  status: 'en_route' | 'arrived'
  arrived_yard_id: string | null
  speed_mph: number | null
  last_milepost: number | null
  last_pass_at: Date | null
}

const empty = (outcome: Outcome): ProcessResult => ({ outcome, events: [], transitions: [], corrections: 0, excludedPreInstall: 0 })

export async function processPass(detectorId: string, passId: string): Promise<ProcessResult> {
  const { config: thresholds } = await loadThresholds()
  const nowMs = clockNow()
  return withTransaction(async (client) => {
    const passRes = await client.query<PassRow>(
      `SELECT p.detector_id, p.pass_id, p.trip_id, p.direction, p.passed_at, p.lag_seconds, p.speed_mph, p.axle_count, p.aei, p.processed_at, d.milepost
         FROM detector_passes p JOIN detectors d ON d.id = p.detector_id
        WHERE p.detector_id = $1 AND p.pass_id = $2 FOR UPDATE OF p`,
      [detectorId, passId],
    )
    const pass = passRes.rows[0]
    if (!pass) return empty('missing')
    if (pass.processed_at) return empty('already_processed')

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pass.trip_id])
    const tripRes = await client.query<TripRow>('SELECT * FROM trips WHERE trip_id = $1 FOR UPDATE', [pass.trip_id])
    const trip = tripRes.rows[0]
    if (!trip) {
      // The pass beat the consist here. Park it; consist ingest republishes parked passes.
      await client.query(`UPDATE detector_passes SET identity_status = 'awaiting_consist' WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
      return empty('awaiting_consist')
    }

    // ── 2. Identity: the consist revision in force when the pass was measured, corrected by any AEI read ──
    const revision = await revisionAt(client, trip.trip_id, pass.passed_at)
    const decision = decideIdentity(await loadUnits(client, trip.trip_id, revision), pass.axle_count, pass.aei)
    if (decision.corrections.length > 0) await persistCorrections(client, trip.trip_id, revision, detectorId, decision.corrections)
    if (decision.status === 'unresolved') {
      await client.query(
        `UPDATE detector_passes SET identity_status = 'unresolved', processed_at = now() WHERE detector_id = $1 AND pass_id = $2`,
        [detectorId, passId],
      )
      return { ...empty('unresolved'), corrections: decision.corrections.length }
    }
    const passInfo = { detectorId, passId, direction: pass.direction, axleCount: pass.axle_count }
    await resolvePassReadings(client, passInfo, decision.units)
    await client.query(`UPDATE detector_passes SET identity_status = 'resolved' WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
    if (decision.corrections.length > 0) await reresolveTrip(client, trip.trip_id, { detectorId, passId })

    // ── 5a. Trip position (newest pass by measurement time wins, not newest by arrival) ──
    const { state: tripState, nextYardId, deskId } = await updateTripPosition(client, trip, pass, nowMs)

    // ── 3. Trend + score ──
    const { candidates, excludedPreInstall, replacedKeys } = await scoreTrip(client, trip, thresholds)

    // ── 4. Alerts ──
    const existing = (
      await client.query<ExistingRow>(
        `SELECT id, car_id, kind, position, tier, status, yard_id, owner_role, owner_id FROM alerts WHERE trip_id = $1 AND status <> 'closed' FOR UPDATE`,
        [trip.trip_id],
      )
    ).rows
    const ownerByCar = await ownersFor(client, candidates.filter((c) => c.score.tier > 0).map((c) => c.carId))
    const ctx = {
      client,
      tripId: trip.trip_id,
      symbol: trip.symbol,
      trip: tripState,
      nowMs,
      triggerPass: { detectorId, passId, passedAt: pass.passed_at, lagSeconds: pass.lag_seconds, milepost: pass.milepost },
      lateAfterMinutes: config.analysis.lateAfterMinutes,
      ownerByCar,
      nextYardId,
      deskId,
    }
    const { events, transitions } = await applyCandidates(ctx, candidates, existing)
    const observedKeys = new Set(candidates.map((c) => alertKey(c.carId, c.kind, c.position)))
    events.push(...(await closeOrphans(ctx, existing, observedKeys, replacedKeys)))

    // ── 5b. Detector health inputs (expected passes, bias samples) ──
    await updateDetectorInputs(client, trip, pass, nowMs, thresholds)

    await client.query(`UPDATE detector_passes SET processed_at = now() WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
    events.push({ type: 'trip.updated', tripId: trip.trip_id })
    return { outcome: 'processed', events, transitions, corrections: decision.corrections.length, excludedPreInstall }
  })
}

async function updateTripPosition(
  client: pg.PoolClient,
  trip: TripRow,
  pass: PassRow,
  nowMs: number,
): Promise<{ state: TripState; nextYardId: string | null; deskId: string | null }> {
  const newer = !trip.last_pass_at || pass.passed_at.getTime() > trip.last_pass_at.getTime()
  const lastMilepost = newer ? pass.milepost : trip.last_milepost
  const lastPassAt = newer ? pass.passed_at : trip.last_pass_at
  const speed = newer ? pass.speed_mph : (trip.speed_mph ?? pass.speed_mph)
  const origin = yardById(trip.origin_yard_id)!
  const destination = yardById(trip.destination_yard_id)!
  const state: TripState = {
    status: trip.status,
    direction: trip.direction,
    stops: trip.stops,
    arrivedYardId: trip.arrived_yard_id,
    speedMph: speed,
    lastMilepost,
    lastPassAtMs: lastPassAt ? lastPassAt.getTime() : null,
    destinationMp: destination.milepost,
    originMp: origin.milepost,
  }
  const position = estimateMilepost(state, nowMs) ?? pass.milepost
  const next = trip.status === 'arrived' ? null : predictNextYard(state, position, YARDS)
  await client.query(
    `UPDATE trips SET last_detector_id = CASE WHEN $2 THEN $3 ELSE last_detector_id END,
            last_milepost = $4, last_pass_at = $5, speed_mph = $6, territory_id = $7,
            next_yard_id = $8, next_yard_eta = $9, updated_at = now()
      WHERE trip_id = $1`,
    [trip.trip_id, newer, pass.detector_id, lastMilepost, lastPassAt, speed, subdivisionAt(position).id, next?.yard.id ?? null,
      next ? new Date(nowMs + next.etaMinutes * 60_000) : null],
  )
  return { state, nextYardId: next?.yard.id ?? null, deskId: trip.status === 'arrived' ? null : subdivisionAt(position).deskId }
}

async function scoreTrip(client: pg.PoolClient, trip: TripRow, t: Thresholds): Promise<{ candidates: Candidate[]; excludedPreInstall: number; replacedKeys: Set<string> }> {
  const passRows = await client.query<{
    detector_id: string; pass_id: string; passed_at: Date; ambient_f: number; lag_seconds: number
    edge_alarms: Array<{ axleSeq: number; rail: Rail }> | null; milepost: number; bias_offset_f: number | null; bias_samples: number; braking_zone: boolean
  }>(
    `SELECT p.detector_id, p.pass_id, p.passed_at, p.ambient_f, p.lag_seconds, p.edge_alarms, d.milepost, d.bias_offset_f, d.bias_samples, d.braking_zone
       FROM detector_passes p JOIN detectors d ON d.id = p.detector_id
      WHERE p.trip_id = $1 AND p.identity_status = 'resolved'`,
    [trip.trip_id],
  )
  const passes = new Map<string, PassContext>()
  for (const p of passRows.rows) {
    const flagged = p.bias_offset_f !== null && p.bias_samples >= t.biasMinSamples && Math.abs(p.bias_offset_f) >= t.biasAlarmF
    passes.set(`${p.detector_id}|${p.pass_id}`, {
      detectorId: p.detector_id,
      passId: p.pass_id,
      milepost: p.milepost,
      passedAtMs: p.passed_at.getTime(),
      ambientF: p.ambient_f,
      biasOffsetF: flagged ? p.bias_offset_f! : 0,
      lagSeconds: p.lag_seconds,
      edgeAlarmKeys: new Set((p.edge_alarms ?? []).map((a) => edgeAlarmKey(a.axleSeq, a.rail))),
      brakingZone: p.braking_zone,
    })
  }
  const readings = await client.query<{
    detector_id: string; pass_id: string; axle_seq: number; rail: Rail; bearing_f: number; wheel_f: number; car_id: string; car_side: 'L' | 'R'; car_axle: number
  }>(
    `SELECT r.detector_id, r.pass_id, r.axle_seq, r.rail, r.bearing_f, r.wheel_f, r.car_id, r.car_side, r.car_axle
       FROM axle_readings r JOIN detector_passes p ON p.detector_id = r.detector_id AND p.pass_id = r.pass_id
      WHERE p.trip_id = $1 AND p.identity_status = 'resolved' AND r.car_id IS NOT NULL`,
    [trip.trip_id],
  )
  const allRows: ReadingRow[] = readings.rows.map((r) => ({
    detectorId: r.detector_id, passId: r.pass_id, axleSeq: r.axle_seq, rail: r.rail, bearingF: r.bearing_f, wheelF: r.wheel_f,
    carId: r.car_id, carSide: r.car_side, carAxle: r.car_axle, passedAtMs: passes.get(`${r.detector_id}|${r.pass_id}`)?.passedAtMs ?? 0,
  }))
  // Event time, not processing time: a reading taken before the current wheelset went on is history of the old one.
  const carIds = [...new Set(allRows.map((r) => r.carId))]
  const cutoffs = await installCutoffs(client, carIds)
  const { current: rows, previous } = splitByInstall(allRows, cutoffs)
  const replacedKeys = new Set(previous.map((r) => `${r.carId}|${r.carSide}${r.carAxle}`))
  const originMp = yardById(trip.origin_yard_id)!.milepost
  // Medians come from every car in the pass (the train-side baseline); only the evidence is filtered.
  const observations = buildObservations(rows, passes, originMp, passMedianMap(allRows))
  const history = await historyFor(client, trip.trip_id, carIds, cutoffs)

  const candidates: Candidate[] = []
  const summaries: Array<[string, string, number, number, number, number, boolean, Date]> = []
  // Brakes act on the whole car, so brake (wheel) alerts are per car: the hottest or coldest wheel speaks for it.
  const wheelByCar = new Map<string, { features: BearingFeatures; score: Score; hotWheels: number }>()
  const coldByCar = new Map<string, { features: BearingFeatures; score: Score }>()
  for (const [key, obs] of observations) {
    const [carId, position] = key.split('|')
    const opts = {
      elevatedSideDelta: t.elevatedSideDelta,
      hotWheelDelta: t.hotWheelDelta,
      maxSpacingMiles: t.maxDetectorSpacingMiles,
      historyElevatedTrips: history.get(key) ?? 0,
      coldWheelDelta: t.coldWheelDelta,
    }
    // Each score is the maximum over every event-time prefix, so arrival order can't change the decision.
    const bearing = scoreOverHistory(obs, opts, t, scoreBearing)
    const features = bearing.latest
    candidates.push({ carId, kind: 'hot_bearing', position, score: bearing.score, features })
    const cold = scoreOverHistory(obs, opts, t, scoreColdWheel).score
    const priorCold = coldByCar.get(carId)
    if (!priorCold || cold.tier > priorCold.score.tier) coldByCar.set(carId, { features, score: cold })
    const wheel = scoreOverHistory(obs, opts, t, scoreHotWheel).score
    const prior = wheelByCar.get(carId)
    const hot = (prior?.hotWheels ?? 0) + (wheel.tier > 0 ? 1 : 0)
    if (!prior || features.wheelDelta > prior.features.wheelDelta) wheelByCar.set(carId, { features, score: wheel, hotWheels: hot })
    else prior.hotWheels = hot
    if (features.maxSideDelta >= 10) {
      const elevated = features.observations >= 3 && features.medianSideDelta >= t.lowHistoryMinSideDelta
      summaries.push([carId, position, features.observations, features.medianSideDelta, features.maxSideDelta,
        Math.max(...obs.map((o) => o.aboveAmbient)), elevated, new Date(features.lastPassedAtMs)])
    }
  }
  for (const [carId, w] of wheelByCar) {
    const reasons = w.score.tier > 0 ? [...w.score.reasons, `${w.hotWheels} of 8 wheels hot`] : w.score.reasons
    candidates.push({ carId, kind: 'hot_wheel' as AlertKind, position: WHEEL_POSITION, score: { tier: w.score.tier, reasons }, features: w.features })
  }
  for (const [carId, c] of coldByCar) candidates.push({ carId, kind: 'cold_wheel' as AlertKind, position: WHEEL_POSITION, score: c.score, features: c.features })
  // The trip's summaries are recomputed wholesale, so a corrected identity leaves no stale row behind.
  await client.query('DELETE FROM bearing_trip_summary WHERE trip_id = $1', [trip.trip_id])
  if (summaries.length > 0) {
    await client.query(
      `INSERT INTO bearing_trip_summary (car_id, kind, position, trip_id, observations, median_side_delta, max_side_delta, max_above_ambient, elevated, last_seen_at)
       SELECT s.car_id, 'hot_bearing', s.position, $1, s.obs, s.med, s.mx, s.abv, s.elev, s.seen
         FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[], $8::bool[], $9::timestamptz[])
              AS s(car_id, position, obs, med, mx, abv, elev, seen)`,
      [trip.trip_id, ...transpose(summaries)],
    )
  }
  return { candidates, excludedPreInstall: previous.length, replacedKeys }
}

/** Per-pass medians over every car (before install filtering), so the baseline doesn't move when one axle's evidence is dropped. */
function passMedianMap(rows: ReadingRow[]): Map<string, PassMedians> {
  const byPass = new Map<string, ReadingRow[]>()
  for (const r of rows) {
    const key = `${r.detectorId}|${r.passId}`
    const list = byPass.get(key)
    if (list) list.push(r)
    else byPass.set(key, [r])
  }
  return new Map([...byPass].map(([k, v]) => [k, passMedians(v)]))
}

async function installCutoffs(client: pg.PoolClient, carIds: string[]): Promise<InstallCutoffs> {
  if (carIds.length === 0) return new Map()
  const { rows } = await client.query<{ car_id: string; axle: number; installed_at: Date; removed_at: Date | null }>(
    'SELECT car_id, axle, installed_at, removed_at FROM component_installs WHERE car_id = ANY($1)',
    [carIds],
  )
  return currentInstalls(rows.map((r) => ({ carId: r.car_id, axle: r.axle, installedAtMs: r.installed_at.getTime(), removedAtMs: r.removed_at?.getTime() ?? null })))
}

function transpose<T extends unknown[]>(rows: T[]): unknown[][] {
  if (rows.length === 0) return []
  return rows[0].map((_, i) => rows.map((r) => (typeof r[i] === 'number' ? Math.round((r[i] as number) * 10) / 10 : r[i])))
}

/** How many of each bearing's last 5 other trips it ran elevated on, counting only trips on the current wheelset. */
async function historyFor(client: pg.PoolClient, tripId: string, carIds: string[], cutoffs: InstallCutoffs): Promise<Map<string, number>> {
  if (carIds.length === 0) return new Map()
  const { rows } = await client.query<{ car_id: string; position: string; elevated: boolean; last_seen_at: Date }>(
    `SELECT car_id, position, elevated, last_seen_at
       FROM (SELECT *, row_number() OVER (PARTITION BY car_id, position ORDER BY last_seen_at DESC) AS rn
               FROM bearing_trip_summary WHERE car_id = ANY($1) AND trip_id <> $2 AND kind = 'hot_bearing') s
      WHERE rn <= 5`,
    [carIds, tripId],
  )
  const out = new Map<string, number>()
  for (const r of rows) {
    const cutoff = cutoffs.get(axleKey(r.car_id, Number(r.position.slice(1))))
    if (!r.elevated || (cutoff !== undefined && r.last_seen_at.getTime() < cutoff)) continue
    const key = `${r.car_id}|${r.position}`
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

async function ownersFor(client: pg.PoolClient, carIds: string[]): Promise<Map<string, string>> {
  if (carIds.length === 0) return new Map()
  const { rows } = await client.query<{ car_id: string; owner_mark: string }>('SELECT car_id, owner_mark FROM railcars WHERE car_id = ANY($1)', [carIds])
  return new Map(rows.map((r) => [r.car_id, r.owner_mark]))
}

