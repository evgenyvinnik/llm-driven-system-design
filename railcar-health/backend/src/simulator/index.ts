/**
 * Simulator: drives the demo scenario against the ingest API in compressed
 * time (default 60x: one real second is one simulated minute) and publishes the
 * simulation clock to Valkey so the API and the analyzer agree on "now".
 *
 *   npm run simulate                 # 60x, about 8 real minutes
 *   npm run simulate -- --speed 240  # 4x faster
 *   npm run simulate -- --api http://localhost:3101
 */
process.env.SERVICE_NAME ??= 'simulator'
import { parseArgs } from 'node:util'
import { createRedisConnection } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { simulatedTime, type ClockMapping } from '../shared/clock.js'
import { DETECTORS, yardById, type DetectorSite } from '../shared/network.js'
import { post } from './client.js'
import { buildConsist, type SimUnit } from './fleet.js'
import { gaussian, mulberry32, stableGaussian } from './rng.js'
import { FAULTS, SITE_ALARM_ABOVE_AMBIENT, TRAINS, type TrainSpec } from './scenario.js'
import { generateReadings } from './thermal.js'
import { buildTimeline } from './timeline.js'

const { values: args } = parseArgs({
  options: {
    speed: { type: 'string', default: '60' },
    api: { type: 'string', default: config.apiUrl },
    seed: { type: 'string', default: '7' },
  },
})
const speed = Math.max(1, Number(args.speed))
const apiUrl = args.api!
const rng = mulberry32(Number(args.seed))

const log = (msg: string, extra: Record<string, unknown> = {}) => {
  const tail = Object.entries(extra).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
  console.log(`[sim ${simLabel()}] ${msg}${tail ? ` ${tail}` : ''}`)
}

// ── Clock ──
const timeline = buildTimeline(TRAINS)
const durationMin = Math.max(...timeline.map((e) => e.at)) + 10
const wall0 = Date.now()
// Anchor so the scenario ends at roughly the real time it finishes: everything stays in the recent past.
const sim0 = wall0 + (durationMin * 60_000) / speed - durationMin * 60_000
const mapping: ClockMapping = { simAnchorMs: sim0, wallAnchorMs: wall0, speed }
const simMs = (minutes: number) => sim0 + minutes * 60_000
const simNowMs = () => simulatedTime(mapping, Date.now())
function simLabel(): string {
  return new Date(simNowMs()).toISOString().slice(11, 16)
}

// ── Trains ──
interface LiveTrain {
  spec: TrainSpec
  tripId: string
  /** The physical train right now (cars set out en route disappear from it). */
  units: SimUnit[]
  revision: number
}
const usedIds = new Set<string>()
const trains = new Map<string, LiveTrain>()
for (const spec of TRAINS) {
  const departed = new Date(simMs(spec.departMinutes))
  const stamp = departed.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-')
  const units = buildConsist({ seed: spec.seed, locomotives: spec.locomotives, cars: spec.cars, usedIds, special: spec.special })
  trains.set(spec.symbol, { spec, tripId: `${spec.symbol}-${stamp}`, units, revision: 1 })
}

// ── Gateways (store-and-forward) ──
interface PassPayload {
  passId: string
  detectorId: string
  passedAt: string
  [key: string]: unknown
}

class Gateway {
  buffer: PassPayload[] = []
  constructor(readonly site: DetectorSite) {}

  online(minute: number): boolean {
    return !FAULTS.gatewayOutages.some((o) => o.detectorId === this.site.id && minute >= o.fromMinutes && minute < o.toMinutes)
  }

  async send(passes: PassPayload[], label: string): Promise<void> {
    const body = { gatewayId: this.site.gatewayId, sentAt: new Date(simNowMs()).toISOString(), passes }
    const res = await post(apiUrl, '/passes', body)
    const r = res.body as { accepted?: number; duplicates?: number; results?: Array<{ late: boolean; lagMinutes: number }> }
    log(`${this.site.id} ${label}`, { status: res.status, accepted: r.accepted, duplicates: r.duplicates, lagMin: r.results?.map((x) => x.lagMinutes) })
  }

  async onPass(payload: PassPayload, minute: number): Promise<void> {
    if (!this.online(minute)) {
      this.buffer.push(payload)
      log(`${this.site.id} link down: buffered pass`, { buffered: this.buffer.length })
      return
    }
    await this.send([payload], 'sent pass')
    if (rng() < FAULTS.duplicateRate) await this.send([payload], 'retried pass (lost ack): expect duplicate')
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    // Store-and-forward queues don't promise order: deliver newest first.
    const batch = [...this.buffer].reverse()
    this.buffer = []
    await this.send(batch, `link restored: delivered ${batch.length} buffered passes out of order`)
    await this.send(batch, 'retried buffered batch (lost ack): expect duplicates')
  }
}
const gateways = new Map(DETECTORS.map((d) => [d.id, new Gateway(d)]))

// ── Event handlers ──
function ambientAt(ms: number, detectorId: string): number {
  const hour = new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60
  return Math.round((58 + 10 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + stableGaussian(detectorId, 1.5)) * 10) / 10
}

async function postConsist(train: LiveTrain, effectiveMinute?: number): Promise<void> {
  const res = await post(apiUrl, '/consists', {
    tripId: train.tripId, symbol: train.spec.symbol, direction: train.spec.direction, originYardId: train.spec.originYardId,
    destinationYardId: train.spec.destinationYardId, stops: train.spec.stops, departedAt: new Date(simMs(train.spec.departMinutes)).toISOString(),
    revision: train.revision,
    ...(effectiveMinute !== undefined ? { effectiveAt: new Date(simMs(effectiveMinute)).toISOString() } : {}),
    units: train.units.map((u) => ({
      position: u.position, unitId: u.unitId, unitType: u.unitType, axleCount: u.axleCount, leadingEnd: u.consistLeadingEnd, loaded: u.loaded,
      ownerMark: u.owner?.mark, ownerName: u.owner?.name, carType: u.owner?.carType,
    })),
  })
  log(`consist ${train.tripId} rev ${train.revision}`, { status: res.status, units: train.units.length })
}

/** Cars set out at an intermediate yard: the train is shorter from here, and the yard system sends consist revision 2. */
async function rebuild(train: LiveTrain, yardId: string, minute: number): Promise<void> {
  const n = train.spec.setOutAt?.lastCars ?? 0
  const setOut = train.units.slice(-n).map((u) => u.unitId)
  train.units = train.units.slice(0, -n)
  train.revision += 1
  log(`${train.spec.symbol} set out ${n} cars at ${yardId}`, { cars: setOut })
  await postConsist(train, minute)
}

async function postTripEvent(train: LiveTrain, kind: 'departed' | 'arrived', yardId: string, minute: number): Promise<void> {
  const res = await post(apiUrl, '/trip-events', { eventId: `${train.tripId}:${kind}:${yardId}`, tripId: train.tripId, kind, yardId, at: new Date(simMs(minute)).toISOString() })
  log(`${train.spec.symbol} ${kind} ${yardId}`, { status: res.status })
}

async function handlePass(train: LiveTrain, detector: DetectorSite, distance: number, minute: number): Promise<void> {
  if (FAULTS.silentDetectors.includes(detector.id)) {
    log(`${detector.id} silent: ${train.spec.symbol} passed unrecorded`)
    return
  }
  const passedAtMs = simMs(minute)
  const speedMph = Math.round((train.spec.speedMph + gaussian(rng) * 1.5) * 10) / 10
  const ambientF = ambientAt(passedAtMs, detector.id)
  const { axles, edgeAlarms } = generateReadings(
    {
      units: train.units, direction: train.spec.direction, distance, milepost: detector.milepost, speedMph, ambientF,
      hourOfDay: new Date(passedAtMs).getUTCHours(), brakingZone: detector.brakingZone, biasF: FAULTS.biasedDetectors[detector.id] ?? 0,
      defects: train.spec.defects, stuckBrakeCars: new Set(train.spec.stuckBrakeCars), inoperativeBrakeCars: new Set(train.spec.inoperativeBrakeCars ?? []),
      siteAlarmAboveAmbient: SITE_ALARM_ABOVE_AMBIENT,
    },
    rng,
  )
  const payload: PassPayload = {
    passId: new Date(passedAtMs).toISOString().replace(/[-:.]/g, '').slice(0, 15),
    detectorId: detector.id,
    tripId: train.tripId,
    passedAt: new Date(passedAtMs).toISOString(),
    direction: train.spec.direction,
    speedMph,
    ambientF,
    axleCount: axles.length / 2,
    axles,
    ...(detector.hasAei ? { aei: train.units.map((u) => ({ position: u.position, unitId: u.unitId, leadingEnd: u.leadingEnd })) } : {}),
    ...(edgeAlarms.length > 0 ? { edgeAlarms } : {}),
  }
  if (edgeAlarms.length > 0) log(`${detector.id} DETECTOR ALARM radioed to ${train.spec.symbol}`, { alarms: edgeAlarms })
  await gateways.get(detector.id)!.onPass(payload, minute)
}

async function heartbeats(minute: number): Promise<void> {
  const beats = [...gateways.values()]
    .filter((g) => g.online(minute))
    .map((g) => ({ detectorId: g.site.id, gatewayId: g.site.gatewayId, sentAt: new Date(simMs(minute)).toISOString(), bufferedPasses: g.buffer.length, selfTest: 'ok' }))
  if (beats.length > 0) await post(apiUrl, '/heartbeats', { heartbeats: beats })
}

// ── Main loop ──
type Tick = { at: number; run: () => Promise<void> }
const ticks: Tick[] = timeline.map((e) => {
  const train = trains.get(e.train.symbol)!
  switch (e.kind) {
    case 'consist':
      return { at: e.at, run: () => postConsist(train) }
    case 'departed':
      return { at: e.at, run: () => postTripEvent(train, 'departed', e.train.originYardId, e.at) }
    case 'arrived':
      return { at: e.at, run: () => postTripEvent(train, 'arrived', e.yardId, e.at) }
    case 'pass':
      return { at: e.at, run: () => handlePass(train, e.detector, e.distance, e.at) }
    case 'rebuilt':
      return { at: e.at, run: () => rebuild(train, e.yardId, e.at) }
  }
})
for (let m = 0; m <= durationMin; m += 10) ticks.push({ at: m, run: () => heartbeats(m) })
for (const outage of FAULTS.gatewayOutages) ticks.push({ at: outage.toMinutes, run: () => gateways.get(outage.detectorId)!.flush() })
ticks.sort((a, b) => a.at - b.at)

async function main(): Promise<void> {
  const redis = createRedisConnection('simulator')
  await redis.set(config.clockKey, JSON.stringify(mapping))
  log('scenario start', { speed, trains: TRAINS.length, simulatedHours: (durationMin / 60).toFixed(1), realMinutes: (durationMin / speed).toFixed(1), api: apiUrl })
  for (const [, t] of trains) log(`train ${t.tripId}`, { units: t.units.length, from: yardById(t.spec.originYardId)?.name, to: yardById(t.spec.destinationYardId)?.name })
  for (const tick of ticks) {
    const due = wall0 + (tick.at * 60_000) / speed
    const wait = due - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try {
      await tick.run()
    } catch (err) {
      log('event failed', { err: (err as Error).message })
    }
  }
  // Keep the clock continuous after the run, at real-time speed.
  const end = simNowMs()
  await redis.set(config.clockKey, JSON.stringify({ simAnchorMs: end, wallAnchorMs: Date.now(), speed: 1 } satisfies ClockMapping))
  log('scenario complete; clock now runs at real time')
  redis.disconnect()
}

await main()
