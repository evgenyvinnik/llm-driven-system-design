/**
 * Simulator: three days of a small railroad in about two minutes.
 *
 * A closed-loop discrete-event simulation. The world (where each car physically is) lives here; the system
 * only learns about it through events posted to the ingest API, as AEI readers, yard systems, the dispatch
 * system and the foreign road's interchange feed would send them. Yards build each departing train from
 * the system's *current* trip plans (GET /trains/runs/:id/planned), so cars the replanner moves really do
 * ride their new trains.
 *
 * Injected on purpose:
 *   - missed AEI reads (~6% line, ~5% yard lead) and missed yard-system reports; one yard-system outage
 *   - CarSighted v1 from Northgate-area readers (old firmware), v2 elsewhere
 *   - a store-and-forward gateway resending a batch (same event ids)
 *   - the foreign road's interchange feed: batched, hours late, shuffled, partly duplicated, and resent
 *     with new event ids; it also names a car the registry does not know (the DLQ demo)
 *   - a six-hour delay on the Northgate–Midland train carrying ~100 cars (two delay updates)
 *   - cars left behind at Midland (missed connection after the fact) and a bad-ordered car
 *   - cancellation of the priority train the replanner chose for the delayed cars (compensation)
 *
 *   npm run simulate                       # 1800x: 72 simulated hours in ~2.4 minutes
 *   npm run simulate -- --speed 3600 --api http://localhost:3501
 */
process.env.SERVICE_NAME ??= 'simulator'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createRedisConnection } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { simulatedTime, type ClockMapping } from '../shared/clock.js'
import { leadSiteFor, lineSiteFor, nextRunOf, runIdFor, runInfo, serviceDateOf, siteById, TRAINS, yardById, type RunInfo } from '../shared/network.js'
import { mulberry32 } from '../domain/rng.js'
import { buildFleet, UNKNOWN_CAR, type FleetCar } from './fleet.js'

const { values: args } = parseArgs({
  options: {
    speed: { type: 'string', default: '1800' },
    api: { type: 'string', default: config.apiUrl },
    hours: { type: 'string', default: '72' },
    seed: { type: 'string', default: '7' },
  },
})
const speed = Math.max(1, Number(args.speed))
const api = args.api!
const HOURS = Number(args.hours)
const rng = mulberry32(Number(args.seed))
const H = 3_600_000
const MINUTE = 60_000

// ── Clock: anchored so the scenario ends at the real time it finishes ──
const D = HOURS * H
const wall0 = Date.now()
const S0 = Math.round(wall0 + D / speed - D)
const END = S0 + D
const mapping: ClockMapping = { simAnchorMs: S0, wallAnchorMs: wall0, speed }
const simNow = () => simulatedTime(mapping, Date.now())
const iso = (ms: number) => new Date(Math.round(ms)).toISOString()
const label = (ms: number) => iso(ms).slice(5, 16).replace('T', ' ')
const log = (msg: string) => console.log(`[sim ${label(simNow())}] ${msg}`)

// ── API client ──
let cookie = ''
async function call(path: string, init: { method?: string; body?: unknown; token?: boolean } = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${api}/api/v1${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(init.token ? { 'X-Ingest-Token': config.ingestToken } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const set = res.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`), { fatal: true })
      return data
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal || attempt >= 5) throw err
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
    }
  }
}

interface Fact {
  eventId: string
  type: string
  version: number
  occurredAt: string
  producer: string
  payload: Record<string, unknown>
}
const fact = (type: string, at: number, producer: string, payload: Record<string, unknown>, version = 1): Fact => ({ eventId: randomUUID(), type, version, occurredAt: iso(at), producer, payload })

let posted = 0
let duplicates = 0
async function post(facts: Fact[]): Promise<void> {
  if (facts.length === 0) return
  const res = (await call('/ingest/events', { method: 'POST', body: { events: facts }, token: true })) as { accepted: number; duplicates: number; rejected: number; results: Array<{ error?: string }> }
  posted += res.accepted
  duplicates += res.duplicates
  if (res.rejected) log(`!! ${res.rejected} rejected: ${res.results.find((r) => r.error)?.error}`)
}

// ── World ──
type Loc = { kind: 'customer' } | { kind: 'yard'; yard: string; since: number } | { kind: 'train'; runId: string } | { kind: 'foreign' } | { kind: 'delivered' }
interface SimCar extends FleetCar {
  tripId: string
  releaseAt: number
  loc: Loc
  badUntil: number
}

const fleet: SimCar[] = buildFleet().map((c) => ({ ...c, tripId: `T-${c.carId}`, releaseAt: 0, loc: { kind: 'customer' }, badUntil: 0 }))
const byId = new Map(fleet.map((c) => [c.carId, c]))
const trains = new Map<string, string[]>() // runId → consist
const cancelled = new Set<string>()
const lpsQueue: Fact[] = []

// ── Incident plan ──
const delayed = nextRunOf('M-NGTMID', S0 + 18 * H)
const delayedArrival = delayed.scheduledArrival + 6 * H
const cancelledZ = nextRunOf('Z-MIDPRT', delayedArrival + (yardById.get('MID')!.minConnectionMinutes * MINUTE))
const leftBehindRun = nextRunOf('M-MIDSDV', S0 + 30 * H)
const outageRun = nextRunOf('M-MIDPRT', S0 + 30 * H)
let badOrderDone = false
let gatewayResent = false

// Release windows: most Northgate→Port cars are released to ride the delayed run.
for (const c of fleet) {
  const f = c.releaseFraction
  // Releases continue until late in the scenario, so it ends with cars at every stage of their trips.
  let start = S0 + 1 * H
  let end = END - 20 * H
  if (c.flow.flow === 'NGT-PRT') {
    if (f < 0.75) {
      start = Math.max(S0 + 0.5 * H, delayed.scheduledDeparture - 22 * H)
      end = delayed.scheduledDeparture - 6 * H
      c.releaseAt = start + (f / 0.75) * (end - start)
      continue
    }
    start = delayed.scheduledDeparture
    end = END - 20 * H
    c.releaseAt = start + ((f - 0.75) / 0.25) * (end - start)
    continue
  }
  c.releaseAt = start + f * (end - start)
}

// ── Event queue ──
interface Action {
  at: number
  name: string
  run: () => Promise<void>
}
const queue: Action[] = []
function schedule(at: number, name: string, run: () => Promise<void>): void {
  let lo = 0
  let hi = queue.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (queue[mid].at <= at) lo = mid + 1
    else hi = mid
  }
  queue.splice(lo, 0, { at, name, run })
}

const chance = (p: number) => rng() < p
const between = (a: number, b: number) => a + rng() * (b - a)

function sighting(car: SimCar, siteId: string, at: number, runId: string | null): Fact {
  const site = siteById.get(siteId)!
  const base = { carId: car.carId, siteId, trainRunId: runId, direction: rng() < 0.5 ? 'E' : 'W', railroad: 'PN' }
  if (site.firmware === 1) return fact('CarSighted', at, `aei:${siteId}`, base, 1)
  return fact('CarSighted', at, `aei:${siteId}`, { ...base, readerConfidence: Math.round(between(0.86, 0.995) * 1000) / 1000, orientation: rng() < 0.5 ? 'A_END_LEADING' : 'B_END_LEADING' }, 2)
}

async function release(car: SimCar): Promise<void> {
  await call('/ingest/trips', {
    method: 'POST',
    token: true,
    body: {
      tripId: car.tripId, carId: car.carId, shipperId: car.shipperId, originYard: car.flow.originYard, destinationYard: car.flow.destinationYard,
      destinationCustomer: car.destinationCustomer, via: car.flow.via, handoffRoad: car.flow.handoffRoad, releasedAt: iso(car.releaseAt),
    },
  })
  if (car.flow.receivedFromForeign) {
    schedule(car.releaseAt + 3 * H, `receive ${car.carId}`, () => receive(car, car.releaseAt + 3 * H))
  } else {
    schedule(car.releaseAt + 2 * H, `pull ${car.carId}`, () => pull(car, car.releaseAt + 2 * H))
  }
}

async function pull(car: SimCar, at: number): Promise<void> {
  car.loc = { kind: 'yard', yard: car.flow.originYard, since: at }
  await post([fact('CarPulled', at, `yard:${car.flow.originYard}`, { carId: car.carId, customerId: `${car.shipperId}-${car.flow.originYard}`, yardId: car.flow.originYard })])
}

async function receive(car: SimCar, at: number): Promise<void> {
  car.loc = { kind: 'yard', yard: 'SDV', since: at }
  if (!chance(0.05)) await post([sighting(car, leadSiteFor('SDV')!.siteId, at, null)])
  // The yard system books the car onto a track a little later (never post an event before it happens).
  const booked = fact('CarArrivedYard', at + 20 * MINUTE, 'yard:SDV', { carId: car.carId, yardId: 'SDV', trainRunId: null, track: 'IX1' })
  schedule(at + 20 * MINUTE, `book ${car.carId}`, () => post([booked]))
  lpsQueue.push(fact('CarInterchanged', at, 'interchange:LPS', { carId: car.carId, interchangePoint: 'SDV', direction: 'received', fromRoad: 'LPS', toRoad: 'PN', waybillRef: `LPS-${car.carId.slice(-5)}` }))
}

async function depart(run: RunInfo): Promise<void> {
  if (cancelled.has(run.runId)) return
  const at = run.scheduledDeparture
  const minConn = yardById.get(run.from)!.minConnectionMinutes * MINUTE
  const planned = (await call(`/trains/runs/${run.runId}/planned`)) as { cars: Array<{ car_id: string }> }
  let eligible = planned.cars
    .map((p) => byId.get(p.car_id))
    .filter((c): c is SimCar => !!c && c.loc.kind === 'yard' && c.loc.yard === run.from && c.loc.since <= at - minConn && c.badUntil <= at)
  if (run.runId === leftBehindRun.runId && eligible.length > 3) {
    const left = eligible.slice(0, 3)
    eligible = eligible.slice(3)
    log(`yard at ${run.from} did not switch ${left.map((c) => c.carId).join(', ')} into ${run.runId} (left behind)`)
  }
  const consist = eligible.slice(0, run.capacity)
  if (consist.length === 0 && planned.cars.length === 0) return
  trains.set(run.runId, consist.map((c) => c.carId))
  for (const c of consist) c.loc = { kind: 'train', runId: run.runId }
  const facts: Fact[] = consist.filter(() => !chance(0.04)).map((c) => fact('CarDepartedYard', at - 10 * MINUTE, `yard:${run.from}`, { carId: c.carId, yardId: run.from, trainRunId: run.runId }))
  facts.push(fact('TrainDeparted', at, 'tms:dispatch', { runId: run.runId, trainId: run.trainId, fromYard: run.from, toYard: run.to, consist: consist.map((c) => c.carId) }))
  await post(facts)
  log(`${run.runId} departed ${run.from} with ${consist.length}/${planned.cars.length} planned cars`)

  const train = TRAINS.find((t) => t.trainId === run.trainId)!
  let arrival = at + between(0.92, 1.12) * train.runP50 * MINUTE
  if (run.runId === delayed.runId) {
    arrival = delayedArrival
    schedule(at + 2 * H, `delay1 ${run.runId}`, () => delay(run, 180, at + 2 * H))
    schedule(at + 4 * H, `delay2 ${run.runId}`, () => delay(run, 360, at + 4 * H))
  }
  schedule(at + (arrival - at) * 0.45, `pass ${run.runId}`, () => pass(run, at + (arrival - at) * 0.45))
  schedule(arrival, `arrive ${run.runId}`, () => arrive(run, arrival))
}

async function delay(run: RunInfo, minutes: number, at: number): Promise<void> {
  const newEta = run.scheduledArrival + minutes * MINUTE
  await post([fact('TrainDelayed', at, 'tms:dispatch', { runId: run.runId, trainId: run.trainId, delayMinutes: minutes, newEtaAt: iso(newEta), location: 'MP 112, Northgate Sub', reason: minutes > 200 ? 'crew outlawed under hours of service; relief crew en route' : 'meet with priority traffic; signal failure at CP 104' })])
  log(`${run.runId} delayed ${minutes / 60} h; new arrival ${label(newEta)}`)
}

async function pass(run: RunInfo, at: number): Promise<void> {
  const site = lineSiteFor(run.from, run.to)
  if (!site) return
  const facts = (trains.get(run.runId) ?? []).filter(() => !chance(0.06)).map((id) => sighting(byId.get(id)!, site.siteId, at, run.runId))
  await post(facts)
  if (!gatewayResent && run.trainId === 'M-NGTSDV' && facts.length) {
    gatewayResent = true
    await post(facts) // the reader gateway lost our ack and sent the same batch again
    log(`AEI gateway ${site.siteId} resent a batch of ${facts.length} reads (same event ids)`)
  }
}

async function arrive(run: RunInfo, at: number): Promise<void> {
  const consist = (trains.get(run.runId) ?? []).map((id) => byId.get(id)!)
  const outage = run.runId === outageRun.runId
  const facts: Fact[] = [fact('TrainArrived', at, 'tms:dispatch', { runId: run.runId, trainId: run.trainId, yardId: run.to })]
  const booked: Fact[] = []
  for (const c of consist) {
    c.loc = { kind: 'yard', yard: run.to, since: at }
    if (!chance(0.05)) facts.push(sighting(c, leadSiteFor(run.to)!.siteId, at - 5 * MINUTE, null))
    if (!outage && !chance(0.04)) booked.push(fact('CarArrivedYard', at + 20 * MINUTE, `yard:${run.to}`, { carId: c.carId, yardId: run.to, trainRunId: run.runId, track: `R${1 + Math.floor(rng() * 9)}` }))
    if (run.to === c.flow.destinationYard) {
      if (c.flow.handoffRoad) {
        const t = at + between(6, 14) * H
        schedule(t, `handoff ${c.carId}`, () => handoff(c, t))
      } else {
        const t = at + between(5, 16) * H
        schedule(t, `place ${c.carId}`, () => place(c, t))
      }
    }
  }
  await post(facts)
  if (booked.length) schedule(at + 20 * MINUTE, `book ${run.runId}`, () => post(booked))
  log(`${run.runId} arrived ${run.to} with ${consist.length} cars${outage ? ' (yard system down: no arrival reports)' : ''}`)
  if (run.runId === delayed.runId && !badOrderDone && consist.length) {
    badOrderDone = true
    const car = consist[0]
    const t = at + 90 * MINUTE
    schedule(t, `bad order ${car.carId}`, async () => {
      car.badUntil = t + 30 * H
      await post([fact('CarBadOrdered', t, 'yard:MID', { carId: car.carId, yardId: 'MID', defect: 'Broken brake rigging; moved to the repair track', estimatedRepairHours: 30 })])
      log(`${car.carId} bad-ordered at MID`)
    })
  }
}

async function place(car: SimCar, at: number): Promise<void> {
  car.loc = { kind: 'delivered' }
  await post([fact('CarPlaced', at, `yard:${car.flow.destinationYard}`, { carId: car.carId, customerId: car.destinationCustomer, yardId: car.flow.destinationYard, railroad: 'PN' })])
}

async function handoff(car: SimCar, at: number): Promise<void> {
  car.loc = { kind: 'foreign' }
  await post([fact('CarInterchanged', at, 'yard:SDV', { carId: car.carId, interchangePoint: 'SDV', direction: 'delivered', fromRoad: 'PN', toRoad: 'LPS', waybillRef: `PN-${car.carId.slice(-5)}` })])
  const seen = at + between(8, 14) * H
  lpsQueue.push(fact('CarSighted', seen, 'interchange:LPS', { carId: car.carId, siteId: 'LPS-AEI-12', trainRunId: null, direction: 'W', railroad: 'LPS' }, 1))
  const placed = seen + between(18, 36) * H
  lpsQueue.push(fact('CarPlaced', placed, 'interchange:LPS', { carId: car.carId, customerId: car.destinationCustomer, yardId: null, railroad: 'LPS' }))
}

/** The foreign road's EDI feed: everything since its last batch, shuffled, with some records twice. */
async function lpsBatch(at: number, opts: { resend?: boolean; withUnknownCar?: boolean } = {}): Promise<Fact[]> {
  const due = lpsQueue.filter((f) => Date.parse(f.occurredAt) <= at)
  for (const f of due) lpsQueue.splice(lpsQueue.indexOf(f), 1)
  if (opts.withUnknownCar) {
    due.push(fact('CarInterchanged', at - 7 * H, 'interchange:LPS', { carId: UNKNOWN_CAR, interchangePoint: 'SDV', direction: 'received', fromRoad: 'LPS', toRoad: 'PN', waybillRef: null }))
  }
  const batch = [...due, ...due.filter(() => chance(0.15))]
  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[batch[i], batch[j]] = [batch[j], batch[i]]
  }
  await post(batch)
  log(`LPS interchange batch: ${due.length} records (${batch.length - due.length} repeated in-batch), oldest ${due.length ? label(Math.min(...due.map((f) => Date.parse(f.occurredAt)))) : '-'}`)
  return due
}

// ── Build the scenario ──
for (const c of fleet) schedule(c.releaseAt, `release ${c.carId}`, () => release(c))
for (let day = Math.floor(S0 / (24 * H)) - 1; day <= Math.floor(END / (24 * H)); day++) {
  for (const t of TRAINS) {
    const run = runInfo(runIdFor(t.trainId, serviceDateOf(day * 24 * H)))!
    if (run.scheduledDeparture >= S0 && run.scheduledDeparture < END) schedule(run.scheduledDeparture, `depart ${run.runId}`, () => depart(run))
  }
}
schedule(cancelledZ.scheduledDeparture - 5 * H, `cancel ${cancelledZ.runId}`, async () => {
  cancelled.add(cancelledZ.runId)
  await post([fact('TrainCancelled', cancelledZ.scheduledDeparture - 5 * H, 'tms:dispatch', { runId: cancelledZ.runId, trainId: 'Z-MIDPRT', fromYard: 'MID', reason: 'no locomotives available; train annulled' })])
  log(`${cancelledZ.runId} CANCELLED`)
})
schedule(S0 + 20 * H, 'lps batch 1', async () => void (await lpsBatch(S0 + 20 * H)))
schedule(S0 + 44 * H, 'lps batch 2', async () => {
  const sent = await lpsBatch(S0 + 44 * H, { withUnknownCar: true })
  // The bridge's acknowledgment was lost; it resends the whole batch with new message ids 15 minutes later.
  schedule(S0 + 44 * H + 15 * MINUTE, 'lps resend', async () => {
    await post(sent.map((f) => ({ ...f, eventId: randomUUID() })))
    log(`LPS resent batch 2 with new event ids (${sent.length} records)`)
  })
})
schedule(S0 + 68 * H, 'lps batch 3', async () => void (await lpsBatch(S0 + 68 * H)))

// ── Run ──
const clockRedis = createRedisConnection('simulator')
await clockRedis.set(config.clockKey, JSON.stringify(mapping))
await call('/auth/login', { method: 'POST', body: { username: 'olivia', password: 'password123' } })
log(`scenario ${label(S0)} → ${label(END)} at ${speed}x; delayed run ${delayed.runId}; priority run to cancel ${cancelledZ.runId}; ${fleet.length} cars, ${queue.length} actions`)

while (queue.length) {
  const action = queue.shift()!
  // The world freezes at the end of the scenario; later actions (placements due tomorrow) never happen.
  if (action.at > END) break
  const wait = (action.at - simNow()) / speed
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  try {
    await action.run()
  } catch (err) {
    log(`!! ${action.name} failed: ${(err as Error).message}`)
  }
}

// Run the clock out to the end of the scenario, then hand it back to real time (sim time = wall time from here on).
const remaining = (END - simNow()) / speed
if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))
const endMapping: ClockMapping = { simAnchorMs: END, wallAnchorMs: Date.now(), speed: 1 }
await clockRedis.set(config.clockKey, JSON.stringify(endMapping))
const stillMoving = fleet.filter((c) => c.loc.kind === 'train' || c.loc.kind === 'yard').length
log(`done: ${posted} events accepted, ${duplicates} duplicates dropped at ingest, ${fleet.filter((c) => c.loc.kind === 'delivered').length} delivered, ${stillMoving} still moving`)
clockRedis.disconnect()
