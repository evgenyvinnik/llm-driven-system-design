/**
 * ETA from yard dwell, not distance over speed.
 *
 * Most of a loaded car's transit time is spent standing in yards: waiting to be classified, inspected and
 * blocked, then waiting for the next train that carries its block. So the model walks the remaining plan
 * yard by yard:
 *
 *   ready     = arrival + yard time      (sampled from the yard's historical distribution for that block,
 *                                         conditioned on how long the car has already been there)
 *   departure = the planned train if the car is ready before it leaves (and it is not cancelled or gone),
 *               otherwise the next train between the same yards (from the schedule)
 *   arrival   = departure + run time     (sampled; a known delay on that run replaces the sample)
 *
 * then adds the destination yard's local delivery time (or the foreign road's time after an interchange).
 * 200 seeded Monte Carlo samples give p10 / p50 / p90. The seed is derived from the car and the plan version
 * (common random numbers), so recomputing from the same events (a replay) gives the same ETA, and successive
 * recomputes differ only because the inputs did.
 * @module domain/eta-model
 */
import type { CarState } from './car-fold.js'
import { dwellFor, nextRunOf, runInfo, trainById, TRAINS, type RunInfo } from '../shared/network.js'
import { hashString, logNormal, logNormalGiven, mulberry32, quantile } from './rng.js'

export interface EtaResult {
  p10: string
  p50: string
  p90: string
  confidence: 'high' | 'medium' | 'low'
  final: boolean
  asOf: string
  basis: {
    startedFrom: string
    /** Mean remaining hours standing in yards vs moving on trains, across samples. */
    yardHours: number
    transitHours: number
    yardShare: number
    /** Share of samples in which the car misses the planned train at its next yard. */
    missNextConnection: number
    nextYard: string | null
    plannedArrival: string | null
  }
}

const MIN = 60_000
const HOUR = 3_600_000
const PULL_MINUTES = 120

function iso(msValue: number): string {
  return new Date(Math.round(msValue / MIN) * MIN).toISOString()
}

/** Trains between two yards, preferred (planned) train first. */
function trainsBetween(from: string, to: string, preferred: string): string[] {
  const others = TRAINS.filter((t) => t.from === from && t.to === to && t.trainId !== preferred).map((t) => t.trainId)
  return [preferred, ...others]
}

/** First run between the two yards departing at or after `atMs` that is not cancelled and has not already left. */
function nextUsableRun(from: string, to: string, preferredTrain: string, atMs: number, state: CarState, asOfMs: number): RunInfo {
  let best: RunInfo | null = null
  for (const trainId of trainsBetween(from, to, preferredTrain)) {
    let t = atMs
    for (let i = 0; i < 6; i++) {
      const run = nextRunOf(trainId, t)
      const gone = state.departed[run.runId] !== undefined && Date.parse(state.departed[run.runId]) <= asOfMs
      if (!state.cancelled.includes(run.runId) && !gone) {
        if (!best || run.scheduledDeparture < best.scheduledDeparture) best = run
        break
      }
      t = run.scheduledDeparture + MIN
    }
  }
  return best ?? nextRunOf(preferredTrain, atMs)
}

function runSample(rng: () => number, trainId: string): number {
  const t = trainById.get(trainId)
  return t ? logNormal(rng, t.runP50, t.runP90) * MIN : 8 * HOUR
}

function yardSample(rng: () => number, yardId: string, block: string, elapsedMs: number): number {
  const d = dwellFor(yardId, block) ?? dwellFor(yardId, 'LOCAL') ?? { p50: 480, p90: 1200 }
  return logNormalGiven(rng, d.p50, d.p90, elapsedMs / MIN) * MIN
}

/**
 * `clockFloor` is the newest ClockTicked boundary: time that has passed with no news still moves the ETA
 * (a car sitting in a yard is conditioned on having waited that long).
 */
export function computeEta(state: CarState, samples = 200, clockFloor: string | null = null): EtaResult | null {
  const plan = state.plan
  if (!plan || !state.asOf) return null
  const asOf = clockFloor && clockFloor > state.asOf ? clockFloor : state.asOf
  const asOfMs = Date.parse(asOf)
  const plannedArrival = plan.legs.length ? plan.legs[plan.legs.length - 1].plannedArrival : null

  if (state.status === 'delivered' && state.deliveredAt) {
    const at = state.deliveredAt
    return {
      p10: at, p50: at, p90: at, confidence: 'high', final: true, asOf: state.asOf,
      basis: { startedFrom: 'delivered', yardHours: 0, transitHours: 0, yardShare: 0, missNextConnection: 0, nextYard: null, plannedArrival },
    }
  }

  // Common random numbers: the same draws on every recompute for this car and plan version, so the ETA
  // moves when the inputs move, not because of sampling noise. Still fully determined by the events.
  const rng = mulberry32(hashString(`${state.carId}|${plan.version}`))
  const results: number[] = []
  let yardTotal = 0
  let transitTotal = 0
  let missed = 0
  let nextYard: string | null = null
  let startedFrom: string = state.status

  for (let i = 0; i < samples; i++) {
    let yardMs = 0
    let transitMs = 0
    let legIdx = state.currentLeg ?? 0
    let yard: string
    let arrival: number
    let elapsed = 0

    if (state.status === 'off_network') {
      // Handed to the foreign road: its own transit time to the final customer.
      const handoff = state.arrivedAt ? Date.parse(state.arrivedAt) : asOfMs
      const foreign = yardSample(rng, plan.destinationYard, 'FOREIGN', asOfMs - handoff)
      results.push(handoff + foreign)
      yardTotal += foreign
      startedFrom = 'foreign road'
      continue
    }

    if (state.status === 'in_transit' && state.trainRunId) {
      const run = runInfo(state.trainRunId)
      const trainId = run?.trainId ?? ''
      const departed = state.departed[state.trainRunId] ? Date.parse(state.departed[state.trainRunId]) : (run?.scheduledDeparture ?? asOfMs)
      const delayed = state.delays[state.trainRunId]
      let arr = delayed ? Date.parse(delayed) + (rng() - 0.5) * HOUR : departed + runSample(rng, trainId)
      arr = Math.max(arr, asOfMs)
      transitMs += arr - Math.max(departed, asOfMs)
      yard = run?.to ?? plan.destinationYard
      arrival = arr
      const idx = plan.legs.findIndex((l) => l.runId === state.trainRunId)
      legIdx = idx >= 0 ? idx + 1 : plan.legs.findIndex((l) => l.fromYard === yard)
      if (legIdx < 0) legIdx = plan.legs.length
      startedFrom = 'on train'
    } else if ((state.status === 'at_yard' || state.status === 'bad_ordered') && state.locationId) {
      yard = state.locationId
      arrival = state.arrivedAt ? Date.parse(state.arrivedAt) : asOfMs
      elapsed = Math.max(0, asOfMs - arrival)
      if (legIdx >= plan.legs.length || plan.legs[legIdx]?.fromYard !== yard) {
        const idx = plan.legs.findIndex((l, j) => j >= (state.currentLeg ?? 0) && l.fromYard === yard)
        legIdx = idx >= 0 ? idx : plan.legs.length
      }
      if (state.status === 'bad_ordered') {
        const repair = yardSample(rng, yard, 'REPAIR', elapsed)
        const repaired = Math.max(arrival + repair, state.repairUntil ? Date.parse(state.repairUntil) : 0)
        yardMs += Math.max(0, repaired - asOfMs)
        arrival = repaired
        elapsed = 0
      }
      startedFrom = state.status === 'bad_ordered' ? 'bad order' : 'yard'
    } else {
      // Released but not yet pulled from the customer.
      yard = plan.originYard
      arrival = Math.max(Date.parse(plan.releasedAt) + PULL_MINUTES * MIN, asOfMs)
      legIdx = 0
      startedFrom = 'origin'
    }

    let firstYard = true
    for (let j = legIdx; j < plan.legs.length; j++) {
      const leg = plan.legs[j]
      const planned = runInfo(leg.runId)
      const plannedGone = state.departed[leg.runId] !== undefined && Date.parse(state.departed[leg.runId]) <= asOfMs
      // Time spent waiting for a planned train that has not left yet is normal, not a sign the car is
      // unready; only once its train has gone does the elapsed time say something about its yard time.
      const dwell = yardSample(rng, yard, leg.toYard, firstYard && (plannedGone || state.cancelled.includes(leg.runId)) ? elapsed : 0)
      const ready = Math.max(arrival + dwell, firstYard ? asOfMs : arrival)
      const plannedOk = planned && !state.cancelled.includes(leg.runId) && !plannedGone && ready <= planned.scheduledDeparture
      const run = plannedOk ? planned : nextUsableRun(leg.fromYard, leg.toYard, leg.trainId, ready, state, asOfMs)
      if (firstYard) {
        nextYard = yard
        if (!plannedOk) missed += 1
      }
      const departure = Math.max(run.scheduledDeparture, ready)
      yardMs += departure - Math.max(arrival, asOfMs)
      const delayed = state.delays[run.runId]
      const arr = delayed ? Date.parse(delayed) : departure + runSample(rng, run.trainId)
      transitMs += arr - departure
      arrival = arr
      yard = leg.toYard
      firstYard = false
    }

    const block = plan.handoffRoad ? 'FOREIGN' : 'LOCAL'
    const last = yardSample(rng, yard, block, firstYard ? elapsed : 0)
    const delivered = Math.max(arrival + last, asOfMs)
    yardMs += delivered - Math.max(arrival, asOfMs)
    results.push(delivered)
    yardTotal += Math.max(0, yardMs)
    transitTotal += Math.max(0, transitMs)
  }

  results.sort((a, b) => a - b)
  const p10 = quantile(results, 0.1)
  const p50 = quantile(results, 0.5)
  const p90 = quantile(results, 0.9)
  const widthH = (p90 - p10) / HOUR
  const levels = ['high', 'medium', 'low'] as const
  let level = widthH < 18 ? 0 : widthH < 36 ? 1 : 2
  if (state.positionConfidence === 'inferred' || state.status === 'bad_ordered') level = Math.min(2, level + 1)
  const yardHours = yardTotal / samples / HOUR
  const transitHours = transitTotal / samples / HOUR
  return {
    p10: iso(p10),
    p50: iso(p50),
    p90: iso(p90),
    confidence: levels[level],
    final: false,
    asOf: new Date(asOfMs).toISOString(),
    basis: {
      startedFrom,
      yardHours: Math.round(yardHours * 10) / 10,
      transitHours: Math.round(transitHours * 10) / 10,
      yardShare: yardHours + transitHours > 0 ? Math.round((yardHours / (yardHours + transitHours)) * 100) / 100 : 0,
      missNextConnection: Math.round((missed / samples) * 100) / 100,
      nextYard,
      plannedArrival,
    },
  }
}
