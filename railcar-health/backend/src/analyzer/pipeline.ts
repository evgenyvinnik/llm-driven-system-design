/**
 * processPass: everything the analyzer does for one detector pass, inside the
 * consumer's transaction (which also records the event as processed and stages
 * every new event), under a per-trip advisory lock: the local stand-in for
 * "partition by trip gives each trip a single writer".
 *
 *   1. Skip if already processed (a parked pass released twice).
 *   2. Resolve identity: consist revision in force at the pass's event time +
 *      AEI corrections -> CarIdentified / IdentityQuarantined.
 *   3. Move the trip (newest pass by event time) -> TripPositionUpdated.
 *   4. Recompute trend features for every bearing on the train from all its
 *      observations in this trip (order-independent) and score them
 *      -> BearingTrendUpdated for bearings this pass changed.
 *   5. Decide cases: AlertRaised / AlertEscalated, hold, work order,
 *      notifications; close cases whose evidence vanished.
 *   6. Detector-health inputs; mark the pass processed.
 * Nothing is published here: the events commit with the transaction and the
 * relay publishes them.
 * @module analyzer/pipeline
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import type { AlertKind, Direction, Rail, Thresholds } from '../shared/domain.js'
import type { LiveEvent } from '../shared/events.js'
import { nowMs as clockNow } from '../shared/clock.js'
import { subdivisionAt, yardById, YARDS } from '../shared/network.js'
import { loadThresholds } from '../shared/thresholds.js'
import { streamIds } from '../events/catalog.js'
import type { EventBatch } from '../events/store.js'
import { installCutoffs as cutoffsFromCars } from '../domain/car.js'
import { loadCars } from '../domain/repository.js'
import { alertKey, applyCandidates, closeOrphans, featureJson, type Candidate, type Transition } from './alert-manager.js'
import { axleKey, splitByInstall, type InstallCutoffs } from './components.js'
import { decideIdentity, expectedAxleCount, type ConsistUnit } from './identity.js'
import { loadUnits, persistCorrections, reresolveTrip, resolvePassReadings, revisionAt } from './resolve.js'
import { scoreBearing, scoreColdWheel, scoreHotWheel, scoreOverHistory, type Score } from './risk.js'
import { estimateMilepost, predictNextYard, type TripState } from './routing.js'
import { bearingKey, buildObservations, edgeAlarmKey, passMedians, type BearingFeatures, type Observation, type PassContext, type PassMedians, type ReadingRow } from './trend.js'
import { updateDetectorInputs } from './health-inputs.js'

/** Wheel alerts cover the whole car. */
export const WHEEL_POSITION = 'CAR'

export type Outcome = 'processed' | 'already_processed' | 'missing' | 'awaiting_consist' | 'unresolved'

export interface PipelineTx {
  client: pg.PoolClient
  batch: EventBatch
}

export interface ProcessResult {
  outcome: Outcome
  notices: LiveEvent[]
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
  identity_status: string
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
  last_detector_id: string | null
}

const empty = (outcome: Outcome): ProcessResult => ({ outcome, notices: [], transitions: [], corrections: 0, excludedPreInstall: 0 })

export async function processPass(tx: PipelineTx, detectorId: string, passId: string): Promise<ProcessResult> {
  const { client, batch } = tx
  const { config: thresholds } = await loadThresholds()
  const nowMs = clockNow()
  const passRes = await client.query<PassRow>(
    `SELECT p.detector_id, p.pass_id, p.trip_id, p.direction, p.passed_at, p.lag_seconds, p.speed_mph, p.axle_count, p.aei, p.identity_status, p.processed_at, d.milepost
       FROM detector_passes p JOIN detectors d ON d.id = p.detector_id
      WHERE p.detector_id = $1 AND p.pass_id = $2 FOR UPDATE OF p`,
    [detectorId, passId],
  )
  const pass = passRes.rows[0]
  if (!pass) return empty('missing')
  if (pass.processed_at) return empty('already_processed')
  const tripStream = streamIds.trip(pass.trip_id)
  const tripTags = [`trip:${pass.trip_id}`]

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pass.trip_id])
  const trip = (await client.query<TripRow>('SELECT * FROM trips WHERE trip_id = $1 FOR UPDATE', [pass.trip_id])).rows[0]
  if (!trip) {
    // The pass beat its consist. Park it; ConsistVersionChanged releases it.
    if (pass.identity_status !== 'awaiting_consist') {
      batch.append(tripStream, 'any', {
        type: 'IdentityQuarantined', occurredAt: pass.passed_at, tags: [...tripTags, `detector:${detectorId}`],
        payload: { tripId: pass.trip_id, detectorId, passId, reason: 'awaiting_consist', detectedAxles: pass.axle_count, expectedAxles: null },
      })
    }
    await client.query(`UPDATE detector_passes SET identity_status = 'awaiting_consist' WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
    return empty('awaiting_consist')
  }

  // ── 2. Identity: the consist revision in force when the pass was measured, corrected by any AEI read ──
  const revision = await revisionAt(client, trip.trip_id, pass.passed_at)
  const units = await loadUnits(client, trip.trip_id, revision)
  const decision = decideIdentity(units, pass.axle_count, pass.aei)
  if (decision.corrections.length > 0) await persistCorrections(client, trip.trip_id, revision, detectorId, decision.corrections)
  if (decision.status === 'unresolved') {
    await client.query(`UPDATE detector_passes SET identity_status = 'unresolved', processed_at = now() WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
    batch.append(tripStream, 'any', {
      type: 'IdentityQuarantined', occurredAt: pass.passed_at, tags: [...tripTags, `detector:${detectorId}`],
      payload: { tripId: trip.trip_id, detectorId, passId, reason: 'axle_count_mismatch', detectedAxles: pass.axle_count, expectedAxles: expectedAxleCount(units) },
    })
    return { ...empty('unresolved'), corrections: decision.corrections.length }
  }
  const passInfo = { detectorId, passId, direction: pass.direction, axleCount: pass.axle_count }
  await resolvePassReadings(client, passInfo, decision.units)
  await client.query(`UPDATE detector_passes SET identity_status = 'resolved' WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
  await emitIdentity(tx, trip.trip_id, revision, pass, decision.corrections)
  if (decision.corrections.length > 0) await reresolveTrip(client, trip.trip_id, { detectorId, passId })

  // ── 3. Trip position (newest pass by measurement time wins, not newest by arrival) ──
  const position = await updateTripPosition(client, trip, pass, nowMs)
  if (position.newer) {
    batch.append(tripStream, 'any', {
      type: 'TripPositionUpdated', occurredAt: pass.passed_at, tags: tripTags,
      payload: {
        tripId: trip.trip_id, symbol: trip.symbol, status: trip.status, detectorId, milepost: pass.milepost, passedAt: pass.passed_at.toISOString(),
        territoryId: position.territoryId, deskId: position.deskId, nextYardId: position.nextYardId, nextYardEta: position.nextYardEta?.toISOString() ?? null,
      },
    })
  }

  // ── 4 + 5. Trend, score, decide ──
  const triggerPass = { detectorId, passId, passedAt: pass.passed_at, lagSeconds: pass.lag_seconds, milepost: pass.milepost }
  const decided = await decideTrip(tx, trip, position.state, triggerPass, nowMs, thresholds)

  // ── 6. Detector health inputs (expected passes, bias samples) ──
  await updateDetectorInputs(client, trip, pass, nowMs, thresholds)
  await client.query(`UPDATE detector_passes SET processed_at = now() WHERE detector_id = $1 AND pass_id = $2`, [detectorId, passId])
  return {
    outcome: 'processed',
    notices: [...decided.notices, { type: 'trip.updated', tripId: trip.trip_id }],
    transitions: decided.transitions,
    corrections: decision.corrections.length,
    excludedPreInstall: decided.excludedPreInstall,
  }
}

/**
 * Re-decides a trip without a new pass: after a wheelset swap, an open case whose evidence all
 * predates the new wheelset closes now instead of on the train's next detector.
 */
export async function rescoreTrip(tx: PipelineTx, tripId: string): Promise<ProcessResult> {
  const { client } = tx
  const { config: thresholds } = await loadThresholds()
  const nowMs = clockNow()
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tripId])
  const trip = (await client.query<TripRow>('SELECT * FROM trips WHERE trip_id = $1 FOR UPDATE', [tripId])).rows[0]
  if (!trip) return empty('missing')
  const last = (
    await client.query<{ detector_id: string; pass_id: string; passed_at: Date; lag_seconds: number; milepost: number }>(
      `SELECT p.detector_id, p.pass_id, p.passed_at, p.lag_seconds, d.milepost FROM detector_passes p JOIN detectors d ON d.id = p.detector_id
        WHERE p.trip_id = $1 AND p.identity_status = 'resolved' ORDER BY p.passed_at DESC LIMIT 1`,
      [tripId],
    )
  ).rows[0]
  if (!last) return empty('missing')
  const state = tripStateOf(trip, trip.last_milepost, trip.last_pass_at, trip.speed_mph ?? 0)
  const decided = await decideTrip(tx, trip, state, { detectorId: last.detector_id, passId: last.pass_id, passedAt: last.passed_at, lagSeconds: last.lag_seconds, milepost: last.milepost }, nowMs, thresholds)
  return { outcome: 'processed', notices: decided.notices, transitions: decided.transitions, corrections: 0, excludedPreInstall: decided.excludedPreInstall }
}

async function decideTrip(
  tx: PipelineTx,
  trip: TripRow,
  state: TripState,
  triggerPass: { detectorId: string; passId: string; passedAt: Date; lagSeconds: number; milepost: number },
  nowMs: number,
  thresholds: Thresholds,
): Promise<{ notices: LiveEvent[]; transitions: Transition[]; excludedPreInstall: number }> {
  const { client, batch } = tx
  const scored = await scoreTrip(client, trip, thresholds, triggerPass)
  // BearingTrendUpdated: telemetry for bearings this pass touched (the case stream keeps decisions only).
  for (const c of scored.candidates) {
    if (c.kind !== 'hot_bearing' || !scored.touched.has(`${c.carId}|${c.position}`)) continue
    if (c.score.tier === 0 && Math.abs(c.features.sideDelta) < thresholds.elevatedSideDelta) continue
    batch.append(streamIds.trip(trip.trip_id), 'any', {
      type: 'BearingTrendUpdated', occurredAt: triggerPass.passedAt, tags: [`trip:${trip.trip_id}`, `car:${c.carId}`],
      payload: { tripId: trip.trip_id, carId: c.carId, position: c.position, detectorId: triggerPass.detectorId, passId: triggerPass.passId, passedAt: triggerPass.passedAt.toISOString(), tier: c.score.tier, excludedPreInstall: 0, features: featureJson(c.features) },
    })
  }
  // A reading from this pass that predates the wheelset now on its axle: say so on the car's timeline.
  for (const x of scored.excludedThisPass) {
    if (x.sideDelta < thresholds.elevatedSideDelta) continue
    batch.append(streamIds.trip(trip.trip_id), 'any', {
      type: 'BearingTrendUpdated', occurredAt: triggerPass.passedAt, tags: [`trip:${trip.trip_id}`, `car:${x.carId}`],
      payload: {
        tripId: trip.trip_id, carId: x.carId, position: x.position, detectorId: triggerPass.detectorId, passId: triggerPass.passId, passedAt: triggerPass.passedAt.toISOString(),
        tier: 0, excludedPreInstall: x.readings,
        features: { sideDelta: Math.round(x.sideDelta), previousComponent: true, installedAt: new Date(x.cutoffMs).toISOString(), note: 'Measured before the wheelset now on this axle was installed: kept as history of the old wheelset, never evidence against the new one' },
      },
    })
  }
  const ownerByCar = await ownersFor(client, scored.candidates.filter((c) => c.score.tier > 0).map((c) => c.carId))
  const ctx = { client, batch, tripId: trip.trip_id, symbol: trip.symbol, trip: state, nowMs, triggerPass, lateAfterMinutes: config.analysis.lateAfterMinutes, ownerByCar }
  const { notices, transitions, existing } = await applyCandidates(ctx, scored.candidates)
  const observedKeys = new Set(scored.candidates.map((c) => alertKey(c.carId, c.kind, c.position)))
  notices.push(...(await closeOrphans(ctx, existing, observedKeys, scored.replacedKeys)))
  return { notices, transitions, excludedPreInstall: scored.excludedPreInstall }
}

/** Emits CarIdentified once per car per consist revision, and again for each AEI correction. */
async function emitIdentity(tx: PipelineTx, tripId: string, revision: number, pass: PassRow, corrections: Array<{ position: number; unitId: string; leadingEnd: 'A' | 'B'; previousUnitId: string; previousLeadingEnd: 'A' | 'B' }>): Promise<void> {
  const { client, batch } = tx
  const first = await client.query(
    `UPDATE trip_consist_versions SET identified_at = $3 WHERE trip_id = $1 AND revision = $2 AND identified_at IS NULL RETURNING 1`,
    [tripId, revision, pass.passed_at],
  )
  const corrected = new Map(corrections.map((c) => [c.position, c]))
  const { rows } = await client.query<{ position: number; unit_id: string; leading_end: 'A' | 'B'; orientation_source: 'consist' | 'aei' }>(
    `SELECT position, unit_id, leading_end, orientation_source FROM trip_units WHERE trip_id = $1 AND revision = $2 AND unit_type = 'car' ORDER BY position`,
    [tripId, revision],
  )
  for (const u of rows) {
    const c = corrected.get(u.position)
    if (!first.rowCount && !c) continue
    batch.append(streamIds.trip(tripId), 'any', {
      type: 'CarIdentified', occurredAt: pass.passed_at, tags: [`trip:${tripId}`, `car:${u.unit_id}`],
      payload: {
        tripId, revision, carId: u.unit_id, position: u.position, leadingEnd: u.leading_end, source: c ? 'aei' : u.orientation_source, detectorId: pass.detector_id,
        passId: pass.pass_id, correctedFrom: c ? { unitId: c.previousUnitId, leadingEnd: c.previousLeadingEnd } : null,
      },
    })
  }
}

function tripStateOf(trip: TripRow, lastMilepost: number | null, lastPassAt: Date | null, speed: number): TripState {
  return {
    status: trip.status,
    direction: trip.direction,
    stops: trip.stops,
    arrivedYardId: trip.arrived_yard_id,
    speedMph: speed,
    lastMilepost,
    lastPassAtMs: lastPassAt ? lastPassAt.getTime() : null,
    destinationMp: yardById(trip.destination_yard_id)!.milepost,
    originMp: yardById(trip.origin_yard_id)!.milepost,
  }
}

async function updateTripPosition(client: pg.PoolClient, trip: TripRow, pass: PassRow, nowMs: number) {
  const newer = !trip.last_pass_at || pass.passed_at.getTime() > trip.last_pass_at.getTime()
  const lastMilepost = newer ? pass.milepost : trip.last_milepost
  const lastPassAt = newer ? pass.passed_at : trip.last_pass_at
  const speed = newer ? pass.speed_mph : (trip.speed_mph ?? pass.speed_mph)
  const state = tripStateOf(trip, lastMilepost, lastPassAt, speed)
  const position = estimateMilepost(state, nowMs) ?? pass.milepost
  const next = trip.status === 'arrived' ? null : predictNextYard(state, position, YARDS)
  const territory = subdivisionAt(position)
  const nextYardEta = next ? new Date(nowMs + next.etaMinutes * 60_000) : null
  await client.query(
    `UPDATE trips SET last_detector_id = CASE WHEN $2 THEN $3 ELSE last_detector_id END,
            last_milepost = $4, last_pass_at = $5, speed_mph = $6, territory_id = $7,
            next_yard_id = $8, next_yard_eta = $9, updated_at = now()
      WHERE trip_id = $1`,
    [trip.trip_id, newer, pass.detector_id, lastMilepost, lastPassAt, speed, territory.id, next?.yard.id ?? null, nextYardEta],
  )
  return { state, newer, territoryId: territory.id, nextYardId: next?.yard.id ?? null, nextYardEta, deskId: trip.status === 'arrived' ? null : territory.deskId }
}

export interface TripScoringInput {
  passes: Map<string, PassContext>
  /** Every resolved reading of the trip (car-relative), with its pass's event time. */
  rows: ReadingRow[]
  cutoffs: InstallCutoffs
  history: Map<string, number>
  originMp: number
  thresholds: Thresholds
}

export interface TripScoring {
  candidates: Candidate[]
  observations: Map<string, Observation[]>
  previous: ReadingRow[]
  replacedKeys: Set<string>
  summaries: Array<[string, string, number, number, number, number, boolean, Date]>
}

/**
 * The pure part of scoring a trip: no database, so the replay tool can re-derive a decision from
 * events alone. Readings measured (event time) before the wheelset now on their axle are split off.
 */
export function scoreTripPure(input: TripScoringInput): TripScoring {
  const t = input.thresholds
  const { current: rows, previous } = splitByInstall(input.rows, input.cutoffs)
  const replacedKeys = new Set(previous.map((r) => `${r.carId}|${r.carSide}${r.carAxle}`))
  // Medians come from every car in the pass (the train-side baseline); only the evidence is filtered.
  const observations = buildObservations(rows, input.passes, input.originMp, passMedianMap(input.rows))
  const candidates: Candidate[] = []
  const summaries: TripScoring['summaries'] = []
  // Brakes act on the whole car, so brake (wheel) alerts are per car: the hottest or coldest wheel speaks for it.
  const wheelByCar = new Map<string, { features: BearingFeatures; score: Score; hotWheels: number }>()
  const coldByCar = new Map<string, { features: BearingFeatures; score: Score }>()
  for (const [key, obs] of observations) {
    const [carId, position] = key.split('|')
    const opts = {
      elevatedSideDelta: t.elevatedSideDelta,
      hotWheelDelta: t.hotWheelDelta,
      maxSpacingMiles: t.maxDetectorSpacingMiles,
      historyElevatedTrips: input.history.get(key) ?? 0,
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
  return { candidates, observations, previous, replacedKeys, summaries }
}

async function scoreTrip(
  client: pg.PoolClient,
  trip: TripRow,
  t: Thresholds,
  trigger: { detectorId: string; passId: string },
): Promise<TripScoring & { excludedPreInstall: number; touched: Set<string>; excludedThisPass: Array<{ carId: string; position: string; sideDelta: number; readings: number; cutoffMs: number }> }> {
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
    passes.set(`${p.detector_id}|${p.pass_id}`, passContextOf(p, flagged ? p.bias_offset_f! : 0))
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
  // The wheelset history is read from the car aggregates' own streams (a consistent read), not from a projection.
  const carIds = [...new Set(allRows.map((r) => r.carId))]
  const cutoffs: InstallCutoffs = cutoffsFromCars(await loadCars(client, carIds))
  const history = await historyFor(client, trip.trip_id, carIds, cutoffs)
  const scored = scoreTripPure({ passes, rows: allRows, cutoffs, history, originMp: yardById(trip.origin_yard_id)!.milepost, thresholds: t })

  // The trip's summaries are recomputed wholesale, so a corrected identity leaves no stale row behind.
  await client.query('DELETE FROM bearing_trip_summary WHERE trip_id = $1', [trip.trip_id])
  if (scored.summaries.length > 0) {
    await client.query(
      `INSERT INTO bearing_trip_summary (car_id, kind, position, trip_id, observations, median_side_delta, max_side_delta, max_above_ambient, elevated, last_seen_at)
       SELECT s.car_id, 'hot_bearing', s.position, $1, s.obs, s.med, s.mx, s.abv, s.elev, s.seen
         FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[], $8::bool[], $9::timestamptz[])
              AS s(car_id, position, obs, med, mx, abv, elev, seen)`,
      [trip.trip_id, ...transpose(scored.summaries)],
    )
  }
  const touched = new Set<string>()
  for (const [key, obs] of scored.observations) if (obs.some((o) => o.detectorId === trigger.detectorId && o.passId === trigger.passId)) touched.add(key)
  // Readings from this pass that were split off as the previous wheelset's history.
  const medians = passMedianMap(allRows)
  const excluded = new Map<string, { carId: string; position: string; sideDelta: number; readings: number; cutoffMs: number }>()
  for (const r of scored.previous) {
    if (r.detectorId !== trigger.detectorId || r.passId !== trigger.passId) continue
    const key = bearingKey(r.carId, r.carSide, r.carAxle)
    const m = medians.get(`${r.detectorId}|${r.passId}`)
    const delta = m ? r.bearingF - m.bearing[r.rail] : 0
    const prior = excluded.get(key)
    excluded.set(key, {
      carId: r.carId, position: `${r.carSide}${r.carAxle}`, sideDelta: Math.max(prior?.sideDelta ?? -Infinity, delta), readings: (prior?.readings ?? 0) + 1,
      cutoffMs: cutoffs.get(axleKey(r.carId, r.carAxle)) ?? 0,
    })
  }
  return { ...scored, excludedPreInstall: scored.previous.length, touched, excludedThisPass: [...excluded.values()] }
}

export function passContextOf(
  p: { detector_id: string; pass_id: string; passed_at: Date; ambient_f: number; lag_seconds: number; edge_alarms: Array<{ axleSeq: number; rail: Rail }> | null; milepost: number; braking_zone: boolean },
  biasOffsetF: number,
): PassContext {
  return {
    detectorId: p.detector_id,
    passId: p.pass_id,
    milepost: p.milepost,
    passedAtMs: p.passed_at.getTime(),
    ambientF: p.ambient_f,
    biasOffsetF,
    lagSeconds: p.lag_seconds,
    edgeAlarmKeys: new Set((p.edge_alarms ?? []).map((a) => edgeAlarmKey(a.axleSeq, a.rail))),
    brakingZone: p.braking_zone,
  }
}

export type { ConsistUnit, PassMedians }

/** Per-pass medians over every car (before install filtering), so the baseline doesn't move when one axle's evidence is dropped. */
export function passMedianMap(rows: ReadingRow[]): Map<string, PassMedians> {
  const byPass = new Map<string, ReadingRow[]>()
  for (const r of rows) {
    const key = `${r.detectorId}|${r.passId}`
    const list = byPass.get(key)
    if (list) list.push(r)
    else byPass.set(key, [r])
  }
  return new Map([...byPass].map(([k, v]) => [k, passMedians(v)]))
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

