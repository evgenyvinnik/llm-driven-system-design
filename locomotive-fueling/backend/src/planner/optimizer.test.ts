import { describe, expect, it } from 'vitest'
import { consistMetrics, greedy, optimize, simulate } from './optimizer.js'
import type { FuelChoice, OptimizerParams, PlanInputs, PlanUnit, RoutePoint } from './types.js'

const LINEAR: OptimizerParams = { gridGal: 25, safetyMarginPct: 0, delayCostPerHour: 0, stopPenalty: 0, valueRemainingFuel: false }

function option(locationId: string, price: number, extra: Partial<FuelChoice> = {}): FuelChoice {
  return {
    optionId: `${locationId}-PAD`,
    locationId,
    kind: 'pad',
    pricePerGal: price,
    fee: 0,
    setupMinutes: 0,
    pumpGpm: 300,
    leadTimeHours: 0,
    cancelFee: 0,
    committed: false,
    available: true,
    ...extra,
  }
}

/** Builds a route: stations[i] = [locationId, price | null, burnToNext]. The last entry is the destination. */
function route(stations: [string, number | null, number][], extra: Record<string, Partial<FuelChoice>> = {}): RoutePoint[] {
  let mile = 0
  return stations.map(([id, price, burn]) => {
    const point: RoutePoint = {
      locationId: id,
      name: id,
      milepost: mile,
      etaMs: mile * 60_000,
      burnToNext: burn,
      options: price === null ? [] : [option(id, price, extra[id])],
    }
    mile += burn / 10
    return point
  })
}

function oneTank(fuelGal: number, capacityGal = 5000, reserveGal = 500): PlanUnit[] {
  return [{ locomotiveId: 'U1', capacityGal, fuelGal, reserveGal, share: 1 }]
}

function inputs(points: RoutePoint[], units: PlanUnit[], params: Partial<OptimizerParams> = {}, destinationPricePerGal: number | null = null): PlanInputs {
  return { nowMs: 0, currentMilepost: 0, burnToFirst: 0, units, points, params: { ...LINEAR, ...params }, destinationPricePerGal }
}

const total = (inp: PlanInputs, stops: ReturnType<typeof optimize>['stops']) => simulate(inp, stops, 1 + inp.params.safetyMarginPct).cost.total

describe('optimize vs greedy on linear costs', () => {
  it('matches the classic greedy on the textbook example', () => {
    // A is pricey, B is cheap, C is pricey again, D is the cheapest. Tank headroom is 4,500.
    const inp = inputs(
      route([
        ['A', 3.0, 1000],
        ['B', 2.0, 2000],
        ['C', 3.5, 1500],
        ['D', 1.5, 2000],
        ['END', null, 0],
      ]),
      oneTank(1500),
    )
    const dp = optimize(inp)
    const g = greedy(inp)
    expect(dp.feasible).toBe(true)
    expect(g.feasible).toBe(true)
    expect(total(inp, dp.stops)).toBeCloseTo(total(inp, g.stops), 6)
    // Greedy buys only what it needs at A, fills to reach D from B, and skips C.
    expect(g.stops.map((s) => s.locationId)).toEqual(['B', 'D'])
  })

  it('agrees with greedy across many random linear routes', () => {
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let trial = 0; trial < 60; trial++) {
      const n = 4 + Math.floor(rand() * 6)
      const stations: [string, number | null, number][] = []
      for (let i = 0; i < n; i++) {
        const priced = i === 0 || rand() < 0.75
        stations.push([`S${i}`, priced ? 2 + Math.round(rand() * 150) / 100 : null, 25 * (10 + Math.floor(rand() * 120))])
      }
      stations.push(['END', null, 0])
      const inp = inputs(route(stations), oneTank(500 + 25 * Math.floor(rand() * 180)))
      const dp = optimize(inp)
      const g = greedy(inp)
      expect(dp.feasible).toBe(g.feasible)
      if (dp.feasible) expect(total(inp, dp.stops)).toBeCloseTo(total(inp, g.stops), 4)
    }
  })
})

describe('optimize with fixed costs', () => {
  it('beats greedy when every stop carries a fee and a stop penalty', () => {
    // Prices fall slowly along the route, so greedy stops everywhere to buy "just enough".
    const stations: [string, number | null, number][] = [
      ['A', 3.0, 1200],
      ['B', 2.95, 1200],
      ['C', 2.9, 1200],
      ['D', 2.85, 1200],
      ['END', null, 0],
    ]
    const fees: Record<string, Partial<FuelChoice>> = Object.fromEntries(['A', 'B', 'C', 'D'].map((id) => [id, { fee: 275, setupMinutes: 40, pumpGpm: 120, kind: 'dtl' as const }]))
    const inp = inputs(route(stations, fees), oneTank(1700), { delayCostPerHour: 450, stopPenalty: 150 })
    const dp = optimize(inp)
    const g = greedy(inp)
    expect(g.stops.length).toBe(3)
    expect(dp.stops.length).toBeLessThan(g.stops.length)
    expect(total(inp, dp.stops)).toBeLessThan(total(inp, g.stops) - 500)
  })

  it('never makes a stop it does not need when fuel is plentiful', () => {
    const inp = inputs(route([['A', 2.5, 1000], ['B', 2.4, 1000], ['END', null, 0]]), oneTank(4500), { stopPenalty: 150 })
    expect(optimize(inp).stops).toEqual([])
  })
})

describe('reserve and capacity constraints', () => {
  it('keeps every unit above reserve at every node under inflated burn', () => {
    const inp = inputs(
      route([['A', 2.6, 1500], ['B', 2.4, 3000], ['C', 3.1, 2500], ['END', null, 0]]),
      oneTank(2600),
      { safetyMarginPct: 0.1, delayCostPerHour: 450, stopPenalty: 150 },
    )
    const dp = optimize(inp)
    expect(dp.feasible).toBe(true)
    const sim = simulate(inp, dp.stops, 1.1)
    expect(sim.feasible).toBe(true)
    expect(sim.minHeadroom).toBeGreaterThanOrEqual(-1)
    for (const s of sim.stops) for (const u of s.perUnit) expect(u.targetGal).toBeLessThanOrEqual(5000)
  })

  it('reports infeasible when a gap is longer than a full tank', () => {
    const inp = inputs(route([['A', 2.5, 1000], ['B', 2.5, 6000], ['END', null, 0]]), oneTank(4000))
    const dp = optimize(inp)
    expect(dp.feasible).toBe(false)
    expect(greedy(inp).feasible).toBe(false)
  })

  it('reports infeasible when the first node is already out of reach', () => {
    const inp = { ...inputs(route([['A', 2.5, 100], ['END', null, 0]]), oneTank(900)), burnToFirst: 500 }
    expect(optimize(inp)).toMatchObject({ feasible: false })
  })

  it('splits fuel across units by burn share and respects the limiting unit', () => {
    const units: PlanUnit[] = [
      { locomotiveId: 'L', capacityGal: 5000, fuelGal: 2000, reserveGal: 500, share: 0.6 },
      { locomotiveId: 'T', capacityGal: 5000, fuelGal: 2500, reserveGal: 500, share: 0.4 },
    ]
    const m = consistMetrics(units)
    expect(m.H0).toBeCloseTo(2500, 6) // unit L limits: (2000 - 500) / 0.6
    const inp = inputs(route([['A', 2.5, 2000], ['B', 3.5, 4000], ['END', null, 0]]), units, { safetyMarginPct: 0.1 })
    const dp = optimize(inp)
    const sim = simulate(inp, dp.stops, 1.1)
    expect(sim.feasible).toBe(true)
    const a = sim.stops.find((s) => s.locationId === 'A')!
    const lead = a.perUnit.find((u) => u.locomotiveId === 'L')!
    const trail = a.perUnit.find((u) => u.locomotiveId === 'T')!
    // Higher-share unit gets filled higher above reserve.
    expect(lead.targetGal - 500).toBeGreaterThan(trail.targetGal - 500)
  })
})

describe('commitments, lead time and terminal value', () => {
  it('treats skipping a committed DTL stop as paying its cancellation fee', () => {
    // With a $150 stop penalty: 900 gal at A costs $2,400; at B $2,268 + $100 fee + $150 = $2,518.
    // Uncommitted, A wins. Committed, skipping B adds the $150 cancellation fee to A ($2,550), so B wins.
    // (Without a stop penalty the DP finds bulk at A plus a token top-up at B, which is cheaper still.)
    const points = route([['A', 2.5, 1000], ['B', 2.52, 1000], ['END', null, 0]], {
      B: { kind: 'dtl', fee: 100, cancelFee: 150, committed: true },
    })
    const inp = inputs(points, oneTank(1600), { stopPenalty: 150 })
    const dp = optimize(inp)
    expect(dp.stops.map((s) => s.locationId)).toEqual(['B'])
    expect(simulate(inp, dp.stops, 1).cost.cancellations).toBe(0)
    const uncommitted = inputs(route([['A', 2.5, 1000], ['B', 2.52, 1000], ['END', null, 0]], { B: { kind: 'dtl', fee: 100, cancelFee: 150 } }), oneTank(1600), { stopPenalty: 150 })
    expect(optimize(uncommitted).stops.map((s) => s.locationId)).toEqual(['A'])
  })

  it('skips options marked unavailable (too late to order a truck)', () => {
    const points = route([['A', 2.0, 1000], ['B', 2.6, 1000], ['END', null, 0]], { A: { available: false, unavailableReason: 'lead time' } })
    const dp = optimize(inputs(points, oneTank(1600)))
    expect(dp.stops.map((s) => s.locationId)).toEqual(['B'])
  })

  it('tanks cheap fuel toward the destination when leftover fuel is valued at the destination price', () => {
    const points = route([['A', 2.5, 1000], ['B', 2.6, 1000], ['END', null, 0]])
    const withValue = optimize(inputs(points, oneTank(1600), { stopPenalty: 150, valueRemainingFuel: true }, 3.4))
    const without = optimize(inputs(points, oneTank(1600), { stopPenalty: 150, valueRemainingFuel: false }, 3.4))
    const levelWith = withValue.stops[0].targets.U1
    const levelWithout = without.stops[0].targets.U1
    expect(levelWith).toBe(5000)
    expect(levelWithout).toBeLessThan(levelWith)
  })
})
