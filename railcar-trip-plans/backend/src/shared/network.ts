/**
 * The simulated network: a fictional railroad (Plains & Northern, mark PN) with four yards, seven daily
 * trains, ten AEI reader sites, an interchange with a fictional foreign road (Lone Pine Southern, LPS) at
 * Sandoval, and ten shippers. Reporting marks, names and numbers are invented for the simulation.
 *
 * The seed writes this into the reference tables; the planner, the ETA model and the simulator read it from
 * here so they agree on schedules without a database round trip.
 * @module shared/network
 */
import type { Queryable } from './db.js'

export const HOME_ROAD = 'PN'
export const FOREIGN_ROAD = 'LPS'

export interface YardSpec {
  yardId: string
  name: string
  minConnectionMinutes: number
  interchangeRoad: string | null
}

export const YARDS: YardSpec[] = [
  { yardId: 'NGT', name: 'Northgate Yard', minConnectionMinutes: 240, interchangeRoad: null },
  { yardId: 'MID', name: 'Midland Yard', minConnectionMinutes: 300, interchangeRoad: null },
  { yardId: 'SDV', name: 'Sandoval Yard', minConnectionMinutes: 240, interchangeRoad: FOREIGN_ROAD },
  { yardId: 'PRT', name: 'Port Terminal', minConnectionMinutes: 180, interchangeRoad: null },
]

export interface TrainSpec {
  trainId: string
  name: string
  from: string
  to: string
  /** Scheduled departure, minutes after 00:00 UTC, daily. */
  departMinute: number
  runP50: number
  runP90: number
  capacity: number
  priority: boolean
}

export const TRAINS: TrainSpec[] = [
  { trainId: 'M-NGTMID', name: 'Northgate–Midland manifest', from: 'NGT', to: 'MID', departMinute: 4 * 60, runP50: 480, runP90: 600, capacity: 120, priority: false },
  { trainId: 'M-NGTSDV', name: 'Northgate–Sandoval manifest', from: 'NGT', to: 'SDV', departMinute: 10 * 60, runP50: 540, runP90: 660, capacity: 100, priority: false },
  { trainId: 'M-MIDPRT', name: 'Midland–Port manifest', from: 'MID', to: 'PRT', departMinute: 20 * 60, runP50: 600, runP90: 720, capacity: 120, priority: false },
  { trainId: 'Z-MIDPRT', name: 'Midland–Port priority', from: 'MID', to: 'PRT', departMinute: 7 * 60, runP50: 540, runP90: 600, capacity: 60, priority: true },
  { trainId: 'M-MIDSDV', name: 'Midland–Sandoval manifest', from: 'MID', to: 'SDV', departMinute: 16 * 60, runP50: 360, runP90: 450, capacity: 100, priority: false },
  { trainId: 'M-SDVPRT', name: 'Sandoval–Port manifest', from: 'SDV', to: 'PRT', departMinute: 8 * 60, runP50: 420, runP90: 540, capacity: 110, priority: false },
  { trainId: 'M-SDVMID', name: 'Sandoval–Midland manifest', from: 'SDV', to: 'MID', departMinute: 22 * 60, runP50: 360, runP90: 450, capacity: 100, priority: false },
]

export interface SiteSpec {
  siteId: string
  name: string
  kind: 'line' | 'yard_lead'
  yardId: string | null
  fromYard: string | null
  toYard: string | null
  firmware: 1 | 2
}

const line = (from: string, to: string, firmware: 1 | 2): SiteSpec => ({
  siteId: `AEI-${from}${to}`,
  name: `${from}–${to} line reader`,
  kind: 'line',
  yardId: null,
  fromYard: from,
  toYard: to,
  firmware,
})
const lead = (yard: string, firmware: 1 | 2): SiteSpec => ({ siteId: `AEI-${yard}-L`, name: `${yard} yard lead reader`, kind: 'yard_lead', yardId: yard, fromYard: null, toYard: null, firmware })

/** Northgate-area readers still run v1 firmware (CarSighted v1); the rest send v2. */
export const SITES: SiteSpec[] = [
  line('NGT', 'MID', 1),
  line('NGT', 'SDV', 1),
  line('MID', 'PRT', 2),
  line('MID', 'SDV', 2),
  line('SDV', 'PRT', 2),
  line('SDV', 'MID', 2),
  lead('NGT', 1),
  lead('MID', 2),
  lead('SDV', 2),
  lead('PRT', 2),
]

/** Preferred train for each leg between origin and destination yards (the replanner may use any train between the same yards). */
export const ROUTES: Record<string, string[]> = {
  'NGT-PRT': ['M-NGTMID', 'M-MIDPRT'],
  'NGT-PRT-via-SDV': ['M-NGTSDV', 'M-SDVPRT'],
  'NGT-SDV': ['M-NGTSDV'],
  'MID-PRT': ['M-MIDPRT'],
  'MID-SDV': ['M-MIDSDV'],
  'SDV-PRT': ['M-SDVPRT'],
  'SDV-MID': ['M-SDVMID'],
}

export interface DwellSpec {
  yardId: string
  block: string
  p10: number
  p50: number
  p90: number
  samples: number
}

const h = (hours: number) => Math.round(hours * 60)

/**
 * Historical yard time (illustrative): arrival until the car is ready to leave on its block, in minutes.
 * The realized dwell adds the wait for the next train that carries the block, which comes from the schedule.
 */
export const DWELL: DwellSpec[] = [
  { yardId: 'NGT', block: 'MID', p10: h(3.5), p50: h(5.5), p90: h(14), samples: 2140 },
  { yardId: 'NGT', block: 'SDV', p10: h(3.5), p50: h(6), p90: h(15), samples: 1310 },
  { yardId: 'NGT', block: 'REPAIR', p10: h(10), p50: h(30), p90: h(80), samples: 96 },
  { yardId: 'MID', block: 'PRT', p10: h(4.5), p50: h(6.5), p90: h(18), samples: 3870 },
  { yardId: 'MID', block: 'SDV', p10: h(4), p50: h(6), p90: h(16), samples: 1655 },
  { yardId: 'MID', block: 'LOCAL', p10: h(3), p50: h(8), p90: h(20), samples: 702 },
  { yardId: 'MID', block: 'REPAIR', p10: h(12), p50: h(36), p90: h(96), samples: 214 },
  { yardId: 'SDV', block: 'PRT', p10: h(3.5), p50: h(5.5), p90: h(15), samples: 2410 },
  { yardId: 'SDV', block: 'MID', p10: h(3.5), p50: h(6), p90: h(16), samples: 880 },
  { yardId: 'SDV', block: 'LOCAL', p10: h(2), p50: h(6), p90: h(16), samples: 940 },
  { yardId: 'SDV', block: 'FOREIGN', p10: h(18), p50: h(40), p90: h(84), samples: 610 },
  { yardId: 'SDV', block: 'REPAIR', p10: h(10), p50: h(30), p90: h(84), samples: 120 },
  { yardId: 'PRT', block: 'LOCAL', p10: h(3), p50: h(8), p90: h(20), samples: 3320 },
  { yardId: 'PRT', block: 'REPAIR', p10: h(10), p50: h(28), p90: h(72), samples: 180 },
]

export interface ShipperSpec {
  shipperId: string
  name: string
  contact: string
}

export const SHIPPERS: ShipperSpec[] = [
  { shipperId: 'S01', name: 'Prairie Grain Co-op', contact: 'logistics@prairiegrain.example' },
  { shipperId: 'S02', name: 'Northgate Milling', contact: 'traffic@northgatemilling.example' },
  { shipperId: 'S03', name: 'Redrock Plastics', contact: 'rail@redrockplastics.example' },
  { shipperId: 'S04', name: 'Bluestem Chemicals', contact: 'carsupply@bluestem.example' },
  { shipperId: 'S05', name: 'Harlan Ag Supply', contact: 'orders@harlanag.example' },
  { shipperId: 'S06', name: 'Westbrook Lumber', contact: 'shipping@westbrook.example' },
  { shipperId: 'S07', name: 'Midland Steel Works', contact: 'inbound@midlandsteel.example' },
  { shipperId: 'S08', name: 'Sandoval Minerals', contact: 'rail@sandovalminerals.example' },
  { shipperId: 'S09', name: 'Coastal Export Partners', contact: 'ops@coastalexport.example' },
  { shipperId: 'S10', name: 'Canyon Paper', contact: 'logistics@canyonpaper.example' },
]

export const yardById = new Map(YARDS.map((y) => [y.yardId, y]))
export const trainById = new Map(TRAINS.map((t) => [t.trainId, t]))
export const siteById = new Map(SITES.map((s) => [s.siteId, s]))
export const lineSiteFor = (from: string, to: string) => SITES.find((s) => s.kind === 'line' && s.fromYard === from && s.toYard === to) ?? null
export const leadSiteFor = (yard: string) => SITES.find((s) => s.kind === 'yard_lead' && s.yardId === yard) ?? null
export const dwellFor = (() => {
  const map = new Map(DWELL.map((d) => [`${d.yardId}|${d.block}`, d]))
  return (yardId: string, block: string): DwellSpec | null => map.get(`${yardId}|${block}`) ?? null
})()

// ── Runs: a train on a service date ──

const DAY_MS = 86_400_000

export function serviceDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function runIdFor(trainId: string, serviceDate: string): string {
  return `${trainId}-${serviceDate.replace(/-/g, '')}`
}

export interface RunInfo {
  runId: string
  trainId: string
  serviceDate: string
  from: string
  to: string
  scheduledDeparture: number
  scheduledArrival: number
  capacity: number
}

/** Parses `M-NGTMID-20261105` back into its schedule. Pure: no database needed. */
export function runInfo(runId: string): RunInfo | null {
  const m = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(runId)
  if (!m) return null
  const train = trainById.get(m[1])
  if (!train) return null
  const serviceDate = `${m[2]}-${m[3]}-${m[4]}`
  const dep = Date.parse(`${serviceDate}T00:00:00Z`) + train.departMinute * 60_000
  return { runId, trainId: train.trainId, serviceDate, from: train.from, to: train.to, scheduledDeparture: dep, scheduledArrival: dep + train.runP50 * 60_000, capacity: train.capacity }
}

/** The first scheduled run of `trainId` departing at or after `atMs`. */
export function nextRunOf(trainId: string, atMs: number): RunInfo {
  const train = trainById.get(trainId)
  if (!train) throw new Error(`unknown train ${trainId}`)
  const day0 = Math.floor(atMs / DAY_MS) * DAY_MS
  for (let d = -1; d < 4; d++) {
    const dep = day0 + d * DAY_MS + train.departMinute * 60_000
    if (dep >= atMs) return runInfo(runIdFor(trainId, serviceDateOf(day0 + d * DAY_MS)))!
  }
  throw new Error('unreachable')
}

/** Idempotently writes run rows for every train and service date in [fromMs - 1 day, toMs + 1 day]. */
export async function materializeRuns(q: Queryable, fromMs: number, toMs: number): Promise<void> {
  const rows: RunInfo[] = []
  for (let day = Math.floor(fromMs / DAY_MS) - 1; day <= Math.floor(toMs / DAY_MS) + 1; day++) {
    for (const t of TRAINS) rows.push(runInfo(runIdFor(t.trainId, serviceDateOf(day * DAY_MS)))!)
  }
  await q.query(
    `INSERT INTO train_runs (run_id, train_id, service_date, from_yard, to_yard, scheduled_departure, scheduled_arrival, capacity)
     SELECT * FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::int[])
     ON CONFLICT (run_id) DO NOTHING`,
    [
      rows.map((r) => r.runId),
      rows.map((r) => r.trainId),
      rows.map((r) => r.serviceDate),
      rows.map((r) => r.from),
      rows.map((r) => r.to),
      rows.map((r) => new Date(r.scheduledDeparture).toISOString()),
      rows.map((r) => new Date(r.scheduledArrival).toISOString()),
      rows.map((r) => r.capacity),
    ],
  )
}
