/**
 * Fuel-stop optimizer.
 *
 * The consist is collapsed into one virtual tank measured in "headroom": the
 * train-gallons of forecast burn the consist can absorb before its first unit
 * reaches reserve. Unit i holds reserve_i + share_i × h when balanced, so one
 * train-gallon of headroom costs S = Σ share_i real gallons, and per-unit
 * targets fall out of a single level. That keeps the dynamic program
 * one-dimensional.
 *
 * DP over (node, discretized headroom): at each node either pass, or stop at
 * one fuel option and fill to level L. Stop cost = fixed part (fee, stop
 * penalty, setup delay, cancellations) + a part linear in gallons (price plus
 * pumping delay). Because the gallon part is affine in L, the inner minimum is
 * a suffix minimum, so the whole DP is O(nodes × levels × options).
 *
 * The reserve is enforced at every node arrival against inflated (≈p90) burn;
 * fuel only falls between nodes, so arrivals are the binding points.
 * @module planner/optimizer
 */
import type { PlanInputs, PlanUnit, SimResult, SimStop, StopSpec, ProfilePoint } from './types.js'

export interface ConsistMetrics {
  /** Σ share: real gallons per train-gallon of headroom. */
  S: number
  /** Current headroom above reserve, train-gallons (negative means a unit is already below reserve). */
  H0: number
  /** Headroom with every unit full. */
  Hcap: number
  reserveTotal: number
  capacityTotal: number
}

export function consistMetrics(units: PlanUnit[]): ConsistMetrics {
  let S = 0
  let H0 = Infinity
  let Hcap = Infinity
  let reserveTotal = 0
  let capacityTotal = 0
  for (const u of units) {
    S += u.share
    H0 = Math.min(H0, (u.fuelGal - u.reserveGal) / u.share)
    Hcap = Math.min(Hcap, (u.capacityGal - u.reserveGal) / u.share)
    reserveTotal += u.reserveGal
    capacityTotal += u.capacityGal
  }
  return { S, H0, Hcap, reserveTotal, capacityTotal }
}

/** Per-unit target levels for a headroom level. */
export function targetsForLevel(units: PlanUnit[], level: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const u of units) out[u.locomotiveId] = Math.min(u.capacityGal, u.reserveGal + u.share * level)
  return out
}

export interface OptimizeResult {
  feasible: boolean
  reason?: string
  stops: StopSpec[]
  /** DP objective (inflated burn), for diagnostics. */
  objective: number
  /** The time budget ran out before the DP finished. */
  timedOut?: boolean
}

export interface OptimizeOptions {
  /** performance.now() value after which the DP gives up. */
  deadline?: number
}

const EPS = 1e-9

export function optimize(inputs: PlanInputs, opts: OptimizeOptions = {}): OptimizeResult {
  const { units, points, params } = inputs
  const m = consistMetrics(units)
  const grid = params.gridGal
  const inflate = 1 + params.safetyMarginPct
  const M = Math.floor(m.Hcap / grid + EPS)
  const n = points.length
  if (n === 0) return { feasible: true, stops: [], objective: 0 }
  if (M < 1) return { feasible: false, reason: 'consist cannot hold more than its reserve', stops: [], objective: Infinity }

  const h0 = Math.floor((m.H0 - inputs.burnToFirst * inflate) / grid + EPS)
  if (h0 < 0) {
    return { feasible: false, reason: `cannot reach ${points[0].name} without dipping into reserve`, stops: [], objective: Infinity }
  }
  const start = Math.min(h0, M)
  const burnIdx = points.map((p) => Math.ceil((p.burnToNext * inflate) / grid - EPS))

  const V: Float64Array[] = new Array(n)
  const choiceOpt: Int16Array[] = new Array(n)
  const choiceLevel: Int32Array[] = new Array(n)

  // Destination: fuel left above reserve is worth the destination price (it fuels the next trip).
  const last = new Float64Array(M + 1)
  const credit = params.valueRemainingFuel && inputs.destinationPricePerGal ? inputs.destinationPricePerGal * m.S * grid : 0
  for (let h = 0; h <= M; h++) last[h] = -credit * h
  V[n - 1] = last

  for (let j = n - 2; j >= 0; j--) {
    if (opts.deadline !== undefined && performance.now() > opts.deadline) {
      return { feasible: false, timedOut: true, reason: 'optimizer time budget exceeded', stops: [], objective: Infinity }
    }
    const next = V[j + 1]
    const b = burnIdx[j]
    const p = points[j]
    const vj = new Float64Array(M + 1).fill(Infinity)
    const co = new Int16Array(M + 1).fill(-1)
    const cl = new Int32Array(M + 1).fill(-1)
    const committedCancel = p.options.reduce((s, o) => s + (o.committed ? o.cancelFee : 0), 0)

    // Pass through.
    for (let h = 0; h <= M; h++) {
      const hn = h - b
      if (hn >= 0 && next[hn] !== Infinity) vj[h] = next[hn] + committedCancel
    }

    // Stop at option oi and fill to level L > h.
    p.options.forEach((o, oi) => {
      if (!o.available) return
      const perStep = grid * m.S * (o.pricePerGal + params.delayCostPerHour / (60 * o.pumpGpm))
      const fixed =
        o.fee +
        params.stopPenalty +
        (params.delayCostPerHour * (o.setupMinutes + (o.queueMinutes ?? 0))) / 60 +
        committedCancel -
        (o.committed ? o.cancelFee : 0)
      // sufMin[L] = min over L' >= L of perStep·L' + next[L' - b]
      const sufMin = new Float64Array(M + 2).fill(Infinity)
      const sufArg = new Int32Array(M + 2).fill(-1)
      for (let L = M; L >= 0; L--) {
        const hn = L - b
        const g = hn >= 0 && next[hn] !== Infinity ? perStep * L + next[hn] : Infinity
        if (g < sufMin[L + 1]) {
          sufMin[L] = g
          sufArg[L] = L
        } else {
          sufMin[L] = sufMin[L + 1]
          sufArg[L] = sufArg[L + 1]
        }
      }
      for (let h = 0; h < M; h++) {
        const best = sufMin[h + 1]
        if (best === Infinity) continue
        const value = best - perStep * h + fixed
        if (value < vj[h] - 1e-6) {
          vj[h] = value
          co[h] = oi
          cl[h] = sufArg[h + 1]
        }
      }
    })
    V[j] = vj
    choiceOpt[j] = co
    choiceLevel[j] = cl
  }

  if (V[0][start] === Infinity) {
    return { feasible: false, reason: 'no combination of stops keeps every unit above reserve', stops: [], objective: Infinity }
  }

  const stops: StopSpec[] = []
  let h = start
  for (let j = 0; j < n - 1; j++) {
    const oi = choiceOpt[j][h]
    if (oi >= 0) {
      const level = choiceLevel[j][h]
      const option = points[j].options[oi]
      stops.push({ locationId: option.locationId, optionId: option.optionId, targets: targetsForLevel(units, level * grid) })
      h = level - burnIdx[j]
    } else {
      h = h - burnIdx[j]
    }
  }
  return { feasible: true, stops, objective: V[0][start] }
}

/**
 * The classic greedy for a fixed route with per-gallon prices only: if a
 * cheaper station is within one tank, buy just enough to reach it; otherwise
 * fill up (or buy just enough to finish). Optimal when costs are linear in
 * gallons; it ignores fees, dwell and stop costs, which is why the DP exists.
 */
export function greedy(inputs: PlanInputs): { feasible: boolean; stops: StopSpec[] } {
  const { units, points, params } = inputs
  const m = consistMetrics(units)
  const inflate = 1 + params.safetyMarginPct
  const n = points.length
  const cum: number[] = [0]
  for (let j = 0; j < n - 1; j++) cum.push(cum[j] + points[j].burnToNext * inflate)
  let h = m.H0 - inputs.burnToFirst * inflate
  let feasible = h >= -EPS
  const stops: StopSpec[] = []
  const cheapest = (j: number) =>
    points[j].options.filter((o) => o.available).reduce<null | (typeof points)[number]['options'][number]>((best, o) => (!best || o.pricePerGal < best.pricePerGal ? o : best), null)

  for (let j = 0; j < n - 1; j++) {
    const here = cheapest(j)
    if (here) {
      let need = Math.min(m.Hcap, cum[n - 1] - cum[j])
      for (let k = j + 1; k < n - 1; k++) {
        if (cum[k] - cum[j] > m.Hcap + EPS) break
        const there = cheapest(k)
        if (there && there.pricePerGal < here.pricePerGal) {
          need = cum[k] - cum[j]
          break
        }
      }
      if (h < need - EPS) {
        stops.push({ locationId: here.locationId, optionId: here.optionId, targets: targetsForLevel(units, need) })
        h = need
      }
    }
    h -= points[j].burnToNext * inflate
    if (h < -1e-6) feasible = false
  }
  return { feasible, stops }
}

/**
 * Walks a plan forward unit by unit: burns each unit's share between nodes,
 * fills to the plan's per-unit targets at its stops, and prices everything.
 * Used to price DP and greedy plans on equal terms, to re-check the current
 * plan when inputs change (hysteresis), and to draw the projected fuel curve.
 * burnFactor 1 is the expected profile; 1 + margin is the reserve check.
 */
export function simulate(inputs: PlanInputs, stops: StopSpec[], burnFactor: number): SimResult {
  const { units, points, params } = inputs
  const m = consistMetrics(units)
  const fuel = units.map((u) => u.fuelGal)
  const total = () => fuel.reduce((s, f) => s + f, 0)
  const headroom = () => Math.min(...units.map((u, i) => (fuel[i] - u.reserveGal) / u.share))
  const burn = (gallons: number) => units.forEach((u, i) => (fuel[i] -= u.share * gallons * burnFactor))

  const profile: ProfilePoint[] = [{ milepost: inputs.currentMilepost, locationId: null, fuelGal: total(), kind: 'start' }]
  const simStops: SimStop[] = []
  const unavailable: string[] = []
  const cost = { fuel: 0, fees: 0, delay: 0, stops: 0, cancellations: 0, terminalCredit: 0, total: 0 }
  let breach: SimResult['breach'] = null
  let minHeadroom = Infinity

  burn(inputs.burnToFirst)
  points.forEach((p, j) => {
    profile.push({ milepost: p.milepost, locationId: p.locationId, fuelGal: total(), kind: 'arrive' })
    const h = headroom()
    minHeadroom = Math.min(minHeadroom, h)
    if (h < -1 && !breach) breach = { locationId: p.locationId, name: p.name, milepost: p.milepost, headroomGal: h * m.S }
    if (j === points.length - 1) {
      if (params.valueRemainingFuel && inputs.destinationPricePerGal) {
        const above = units.reduce((s, u, i) => s + Math.max(0, fuel[i] - u.reserveGal), 0)
        cost.terminalCredit = above * inputs.destinationPricePerGal
      }
      return
    }
    const spec = stops.find((s) => s.locationId === p.locationId)
    const option = spec ? p.options.find((o) => o.optionId === spec.optionId) : undefined
    for (const o of p.options) if (o.committed && o.optionId !== option?.optionId) cost.cancellations += o.cancelFee
    if (spec && (!option || (!option.available && !option.committed))) unavailable.push(`${p.name}: ${option?.unavailableReason ?? 'option no longer offered'}`)
    if (spec && option && (option.available || option.committed)) {
      const perUnit = units.map((u, i) => {
        const target = Math.min(u.capacityGal, spec.targets[u.locomotiveId] ?? u.capacityGal * 0.9)
        return { locomotiveId: u.locomotiveId, arrivalGal: fuel[i], targetGal: target, gallons: Math.max(0, target - fuel[i]) }
      })
      const gallons = perUnit.reduce((s, x) => s + x.gallons, 0)
      if (gallons >= 1) {
        const queueMinutes = option.queueMinutes ?? 0
        const dwellMinutes = queueMinutes + option.setupMinutes + gallons / option.pumpGpm
        const stop: SimStop = {
          seq: simStops.length + 1,
          locationId: p.locationId,
          name: p.name,
          optionId: option.optionId,
          kind: option.kind,
          milepost: p.milepost,
          etaMs: p.etaMs,
          gallons,
          perUnit,
          pricePerGal: option.pricePerGal,
          fuelCost: gallons * option.pricePerGal,
          fee: option.fee,
          delayCost: (params.delayCostPerHour * dwellMinutes) / 60,
          dwellMinutes,
          queueMinutes,
          committed: option.committed,
        }
        simStops.push(stop)
        cost.fuel += stop.fuelCost
        cost.fees += stop.fee
        cost.delay += stop.delayCost
        cost.stops += params.stopPenalty
        perUnit.forEach((x, i) => (fuel[i] += x.gallons))
        profile.push({ milepost: p.milepost, locationId: p.locationId, fuelGal: total(), kind: 'depart' })
      } else if (option.committed) {
        cost.cancellations += option.cancelFee
      }
    }
    burn(p.burnToNext)
  })

  cost.total = cost.fuel + cost.fees + cost.delay + cost.stops + cost.cancellations - cost.terminalCredit
  return {
    feasible: breach === null && unavailable.length === 0,
    breach,
    unavailable,
    stops: simStops,
    cost,
    profile,
    minHeadroom: minHeadroom === Infinity ? m.H0 : minHeadroom,
    reserveTotalGal: m.reserveTotal,
    capacityTotalGal: m.capacityTotal,
  }
}

/** A short, stable description of a plan's shape: which options it stops at. */
export function stopSignature(stops: { locationId: string; optionId: string }[]): string {
  return stops.map((s) => s.optionId).join(' → ') || 'no stops'
}
