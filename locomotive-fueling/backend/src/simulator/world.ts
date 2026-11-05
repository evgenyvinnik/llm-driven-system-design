/**
 * The simulated world: true train positions and true fuel in every tank, and
 * what the onboard units report about them. Pure apart from Math.random
 * (seeded). The rest of the system never sees the truth, only telemetry.
 * @module simulator/world
 */
import { buildLegs, legAt, nodeMileposts, NOTCH_GAL_PER_HOUR, IDLE_GAL_PER_HOUR, tiltOffset, workGallons, type Leg } from '../domain/consumption.js'
import { LOCATIONS, TRACKS } from '../domain/network.js'

export interface SimUnit {
  id: string
  horsepower: number
  tankGal: number
  /** True efficiency, a little off the model's figure. */
  modelFactorTruth: number
  fuel: number
  leakGph: number
  sensorBias: number
  notchDebt: number
  notch: number
}

export interface Instruction {
  stopKey: string
  locationId: string
  optionId: string
  kind: 'pad' | 'dtl'
  perUnit: { locomotiveId: string; targetGal: number }[]
  setupMinutes: number
  pumpGpm: number
  pricePerGal: number
  vendorOrderId: string | null
  orderStatus: string | null
}

export type Dwell =
  | { kind: 'fuel'; instruction: Instruction; phase: 'setup' | 'pumping' | 'done'; until: number; remaining: Record<string, number>; delivered: Record<string, number>; requested: Record<string, number> }
  | { kind: 'terminal'; phase: 'setup' | 'pumping' | 'settle'; until: number; remaining: Record<string, number>; delivered: Record<string, number> }
  /** Waiting to depart: after fueling, or after a DTL truck failed to show. */
  | { kind: 'wait'; until: number }

export interface SimTrain {
  id: string
  symbol: string
  routeId: string
  path: string[]
  legs: Leg[]
  nodes: { locationId: string; milepost: number }[]
  totalMiles: number
  plannedTons: number
  actualTons: number
  milepost: number
  speed: number
  units: SimUnit[]
  state: 'running' | 'dwelling' | 'arrived'
  dwell: Dwell | null
  arrivedAt: number | null
  instructions: Instruction[]
  instructionsAt: number
  /** Nodes already handled (stopped at or deliberately passed), so a node isn't re-evaluated. */
  handledNodes: Set<number>
  darkBuffer: Reading[]
}

export interface Reading {
  locomotiveId: string
  seq: number
  recordedAt: number
  lat: number
  lon: number
  milepost: number
  speedMph: number
  notch: number
  fuelGal: number
  engineState: 'run' | 'idle' | 'off'
}

let rngState = 42
export function seedRandom(seed: number): void {
  rngState = seed >>> 0 || 42
}
export function rand(): number {
  // mulberry32
  rngState = (rngState + 0x6d2b79f5) >>> 0
  let t = rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
export function gaussian(): number {
  const u = Math.max(1e-9, rand())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

export function makeTrain(args: { id: string; symbol: string; routeId: string; path: string[]; plannedTons: number; milepost: number; units: SimUnit[]; tonsFactor?: number }): SimTrain {
  const legs = buildLegs(args.path, TRACKS)
  return {
    id: args.id,
    symbol: args.symbol,
    routeId: args.routeId,
    path: args.path,
    legs,
    nodes: nodeMileposts(legs),
    totalMiles: legs[legs.length - 1].endMile,
    plannedTons: args.plannedTons,
    actualTons: args.plannedTons * (args.tonsFactor ?? 0.97 + rand() * 0.07),
    milepost: args.milepost,
    speed: 0,
    units: args.units,
    state: 'running',
    dwell: null,
    arrivedAt: null,
    instructions: [],
    instructionsAt: 0,
    handledNodes: new Set(nodeMileposts(legs).map((n, i) => (n.milepost <= args.milepost + 0.01 ? i : -1)).filter((i) => i >= 0)),
    darkBuffer: [],
  }
}

/** Replace the path ahead (reroute). Mileposts behind the train are unchanged. */
export function setPath(t: SimTrain, path: string[]): void {
  t.path = path
  t.legs = buildLegs(path, TRACKS)
  t.nodes = nodeMileposts(t.legs)
  t.totalMiles = t.legs[t.legs.length - 1].endMile
  t.instructionsAt = 0
}

const loc = new Map(LOCATIONS.map((l) => [l.id, l]))

export function position(t: SimTrain): { lat: number; lon: number } {
  const leg = legAt(t.legs, t.milepost)
  if (!leg) return { lat: 0, lon: 0 }
  const a = loc.get(leg.from)!
  const b = loc.get(leg.to)!
  const f = Math.min(1, Math.max(0, (t.milepost - leg.startMile) / leg.miles))
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }
}

/** Picks a notch so that the average burn over time matches the required rate (engineers modulate). */
function chooseNotch(u: SimUnit, requiredGph: number): number {
  let lo = 0
  while (lo < 8 && NOTCH_GAL_PER_HOUR[lo + 1] <= requiredGph) lo++
  if (lo === 8) return 8
  const span = NOTCH_GAL_PER_HOUR[lo + 1] - NOTCH_GAL_PER_HOUR[lo]
  const frac = (requiredGph - NOTCH_GAL_PER_HOUR[lo]) / span
  u.notchDebt += frac
  if (u.notchDebt >= 1) {
    u.notchDebt -= 1
    return lo + 1
  }
  return lo
}

/** Dark territory is a 40-mile stretch in the middle of a segment flagged dark (canyon, remote desert). */
export function isDark(t: SimTrain): boolean {
  if (t.state !== 'running') return false
  const leg = legAt(t.legs, t.milepost)
  if (!leg?.dark) return false
  const mid = (leg.startMile + leg.endMile) / 2
  return Math.abs(t.milepost - mid) < 20
}

/**
 * The fastest speed the consist can hold on this leg: at full throttle every
 * unit burns notch-8 fuel, and the train slows until the work per hour fits.
 * Heavy trains crawl up grades instead of burning more than an engine can.
 */
export function powerLimitedSpeed(t: SimTrain, leg: Leg, desired: number): number {
  const maxGph = t.units.length * (NOTCH_GAL_PER_HOUR[8] - IDLE_GAL_PER_HOUR)
  let v = desired
  for (let i = 0; i < 4; i++) {
    const perMile = workGallons(t.actualTons, 1, leg.rise / leg.miles, leg.curveLbPerTon, v)
    const gph = perMile * v
    if (gph <= maxGph) break
    v = Math.max(8, v * (maxGph / gph))
  }
  return v
}

/** Burns fuel for an interval at speed over distance (or idling when stopped). */
export function burn(t: SimTrain, hours: number, miles: number): void {
  const leg = legAt(t.legs, t.milepost)
  const online = t.units.reduce((s, u) => s + u.horsepower, 0)
  const work = miles > 0 && leg ? workGallons(t.actualTons, miles, (leg.rise * miles) / leg.miles, leg.curveLbPerTon, t.speed) : 0
  for (const u of t.units) {
    const required = hours > 0 ? (work * (u.horsepower / online)) / hours + IDLE_GAL_PER_HOUR : IDLE_GAL_PER_HOUR
    u.notch = miles > 0 ? chooseNotch(u, required) : 0
    const engineGph = t.state === 'arrived' ? 0 : NOTCH_GAL_PER_HOUR[u.notch] * u.modelFactorTruth
    u.fuel = Math.max(0, u.fuel - (engineGph + u.leakGph) * hours)
  }
}

/** What the tank sensor reports: truth + bias + slosh (grade, acceleration) + noise + rare spikes. */
export function sensorReading(t: SimTrain, u: SimUnit, accelMphPerMin: number): number {
  const leg = legAt(t.legs, t.milepost)
  const moving = t.speed > 1
  let noise = gaussian() * (moving ? 45 : 8)
  if (moving) noise += tiltOffset(leg) + 50 * accelMphPerMin
  if (moving && rand() < 0.015) noise += (rand() < 0.5 ? -1 : 1) * 550
  return Math.max(0, u.fuel + u.sensorBias + noise)
}

export function makeReadings(t: SimTrain, simMs: number, accel: number): Reading[] {
  const { lat, lon } = position(t)
  return t.units.map((u) => ({
    locomotiveId: u.id,
    seq: Math.floor(simMs / 1000),
    recordedAt: simMs,
    lat,
    lon,
    milepost: Math.round(t.milepost * 1000) / 1000,
    speedMph: Math.round(t.speed * 10) / 10,
    notch: u.notch,
    fuelGal: Math.round(sensorReading(t, u, accel) * 10) / 10,
    engineState: t.state === 'arrived' ? 'off' : t.state === 'dwelling' || t.speed < 1 ? 'idle' : 'run',
  }))
}
