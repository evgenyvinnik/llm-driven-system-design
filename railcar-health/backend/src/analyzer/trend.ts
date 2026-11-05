/**
 * Trend features for one bearing within one trip, computed from every
 * observation of it so far. The per-bearing state is the ordered list of
 * observations keyed by detector pass, not a running accumulator: a late or
 * redelivered pass is inserted into the list and the features are recomputed,
 * so out-of-order arrival and duplicates give the same answer as in-order data.
 *
 * Relative features (delta vs the median of the same rail in the same pass,
 * rank within the train) cancel speed, load, braking zones, sun on one side and
 * a detector's calibration offset. Absolute above-ambient temperature does not,
 * which is why it is corrected for known detector bias.
 * @module analyzer/trend
 */
import type { Rail } from '../shared/domain.js'

export interface PassContext {
  detectorId: string
  passId: string
  milepost: number
  passedAtMs: number
  ambientF: number
  /** Known calibration offset of the detector (negative = reads low); 0 if not flagged biased. */
  biasOffsetF: number
  lagSeconds: number
  edgeAlarmKeys: Set<string>
}

export interface ReadingRow {
  detectorId: string
  passId: string
  axleSeq: number
  rail: Rail
  bearingF: number
  wheelF: number
  carId: string
  carSide: 'L' | 'R'
  carAxle: number
}

export interface Observation {
  detectorId: string
  passId: string
  milepost: number
  distance: number
  passedAtMs: number
  rawAboveAmbient: number
  aboveAmbient: number
  sideDelta: number
  percentile: number
  wheelDelta: number
  lagSeconds: number
  edgeAlarm: boolean
  biasCorrected: boolean
}

export interface FeatureOptions {
  elevatedSideDelta: number
  hotWheelDelta: number
  maxSpacingMiles: number
  historyElevatedTrips: number
}

export interface BearingFeatures {
  observations: number
  aboveAmbient: number
  sideDelta: number
  maxSideDelta: number
  medianSideDelta: number
  risePer15mi: number | null
  consecutiveElevated: number
  percentile: number
  maxGapMiles: number
  coverageGap: boolean
  biasCorrected: boolean
  historyElevatedTrips: number
  wheelDelta: number
  wheelConsecutiveHot: number
  edgeAlarm: boolean
  lastDetectorId: string
  lastPassId: string
  lastPassedAtMs: number
  lastLagSeconds: number
  lastMilepost: number
}

export interface PassMedians {
  bearing: Record<Rail, number>
  wheel: Record<Rail, number>
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Percentile rank (0-100) of value within an ascending array. */
export function percentileRank(sortedAsc: number[], value: number): number {
  if (sortedAsc.length === 0) return 0
  let below = 0
  let equal = 0
  for (const v of sortedAsc) {
    if (v < value) below += 1
    else if (v === value) equal += 1
  }
  return ((below + 0.5 * equal) / sortedAsc.length) * 100
}

/** Least-squares slope of y over x. */
export function slope(points: Array<[number, number]>): number | null {
  if (points.length < 2) return null
  const n = points.length
  const mx = points.reduce((s, p) => s + p[0], 0) / n
  const my = points.reduce((s, p) => s + p[1], 0) / n
  let num = 0
  let den = 0
  for (const [x, y] of points) {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  }
  return den === 0 ? null : num / den
}

export const bearingKey = (carId: string, side: string, axle: number) => `${carId}|${side}${axle}`
export const edgeAlarmKey = (axleSeq: number, rail: string) => `${axleSeq}:${rail}`
const passKey = (detectorId: string, passId: string) => `${detectorId}|${passId}`

/** Per-rail medians of car bearing and wheel temperatures in one pass. */
export function passMedians(rows: Array<Pick<ReadingRow, 'rail' | 'bearingF' | 'wheelF'>>): PassMedians {
  const pick = (rail: Rail, field: 'bearingF' | 'wheelF') => median(rows.filter((r) => r.rail === rail).map((r) => r[field]))
  return {
    bearing: { N: pick('N', 'bearingF'), S: pick('S', 'bearingF') },
    wheel: { N: pick('N', 'wheelF'), S: pick('S', 'wheelF') },
  }
}

/** Groups a trip's resolved readings into ordered observations per bearing. */
export function buildObservations(rows: ReadingRow[], passes: Map<string, PassContext>, originMp: number): Map<string, Observation[]> {
  const byPass = new Map<string, ReadingRow[]>()
  for (const row of rows) {
    const key = passKey(row.detectorId, row.passId)
    const list = byPass.get(key)
    if (list) list.push(row)
    else byPass.set(key, [row])
  }
  const out = new Map<string, Observation[]>()
  for (const [key, passRows] of byPass) {
    const ctx = passes.get(key)
    if (!ctx) continue
    const medians = passMedians(passRows)
    const sorted: Record<Rail, number[]> = {
      N: passRows.filter((r) => r.rail === 'N').map((r) => r.bearingF).sort((a, b) => a - b),
      S: passRows.filter((r) => r.rail === 'S').map((r) => r.bearingF).sort((a, b) => a - b),
    }
    for (const row of passRows) {
      const rawAbove = row.bearingF - ctx.ambientF
      const obs: Observation = {
        detectorId: ctx.detectorId,
        passId: ctx.passId,
        milepost: ctx.milepost,
        distance: Math.abs(ctx.milepost - originMp),
        passedAtMs: ctx.passedAtMs,
        rawAboveAmbient: rawAbove,
        aboveAmbient: rawAbove - ctx.biasOffsetF,
        sideDelta: row.bearingF - medians.bearing[row.rail],
        percentile: percentileRank(sorted[row.rail], row.bearingF),
        wheelDelta: row.wheelF - medians.wheel[row.rail],
        lagSeconds: ctx.lagSeconds,
        edgeAlarm: ctx.edgeAlarmKeys.has(edgeAlarmKey(row.axleSeq, row.rail)),
        biasCorrected: ctx.biasOffsetF !== 0,
      }
      const bKey = bearingKey(row.carId, row.carSide, row.carAxle)
      const list = out.get(bKey)
      if (list) list.push(obs)
      else out.set(bKey, [obs])
    }
  }
  return out
}

function trailingCount(values: number[], threshold: number): number {
  let count = 0
  for (let i = values.length - 1; i >= 0 && values[i] >= threshold; i--) count += 1
  return count
}

/** Features as of the bearing's latest observation. Observations may be in any order. */
export function computeFeatures(observations: Observation[], opts: FeatureOptions): BearingFeatures {
  if (observations.length === 0) throw new Error('computeFeatures needs at least one observation')
  // Order by distance travelled (equivalently, by time within a trip); arrival order is irrelevant.
  const obs = [...observations].sort((a, b) => a.distance - b.distance || a.passedAtMs - b.passedAtMs)
  const last = obs[obs.length - 1]
  const deltas = obs.map((o) => o.sideDelta)
  // Rise rate per mile from up to the last 4 observations, so a detector that is silent (a
  // 30-mile gap) stretches the x-axis instead of being treated as the next 15 miles.
  const window = obs.slice(-4)
  const perMile = window.length >= 3 ? slope(window.map((o) => [o.distance, o.sideDelta])) : null
  let maxGap = 0
  for (let i = 1; i < obs.length; i++) maxGap = Math.max(maxGap, obs[i].distance - obs[i - 1].distance)
  return {
    observations: obs.length,
    aboveAmbient: last.aboveAmbient,
    sideDelta: last.sideDelta,
    maxSideDelta: Math.max(...deltas),
    medianSideDelta: median(deltas),
    risePer15mi: perMile === null ? null : perMile * 15,
    consecutiveElevated: trailingCount(deltas, opts.elevatedSideDelta),
    percentile: last.percentile,
    maxGapMiles: maxGap,
    coverageGap: maxGap > opts.maxSpacingMiles,
    biasCorrected: last.biasCorrected,
    historyElevatedTrips: opts.historyElevatedTrips,
    wheelDelta: last.wheelDelta,
    wheelConsecutiveHot: trailingCount(obs.map((o) => o.wheelDelta), opts.hotWheelDelta),
    edgeAlarm: obs.some((o) => o.edgeAlarm),
    lastDetectorId: last.detectorId,
    lastPassId: last.passId,
    lastPassedAtMs: last.passedAtMs,
    lastLagSeconds: last.lagSeconds,
    lastMilepost: last.milepost,
  }
}
