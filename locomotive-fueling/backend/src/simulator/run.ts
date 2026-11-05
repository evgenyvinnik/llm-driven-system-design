/**
 * Fleet simulator (loaded by index.ts). Plays three roles the real system integrates with:
 * - onboard units: telemetry batches per train, with noisy sensors, dark
 *   territory (buffer, then flush), duplicate batches, re-sent readings and
 *   out-of-order delivery;
 * - crews and fuel pads: trains stop where the current plan says, fill to the
 *   plan's per-unit targets, and the pad posts a ticket; DTL stops call the
 *   mock vendor, which only delivers against a confirmed order;
 * - dispatch and suppliers: scripted scenarios (heavier-than-planned train,
 *   leak, price change, reroute, sensor fault, vendor timeout and refusal,
 *   short fill) and new trips when trains arrive.
 * Time is compressed (SIM_SPEEDUP). Control and status on SIMULATOR_PORT.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import { DETOUR_FROM_WEL, FUEL_OPTIONS, ROUTES } from '../domain/network.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { burn, isDark, makeReadings, makeTrain, powerLimitedSpeed, rand, seedRandom, setPath, type Instruction, type Reading, type SimTrain, type SimUnit } from './world.js'

const api = config.apiUrl
const integrationHeaders = { 'Content-Type': 'application/json', 'X-Integration-Token': config.integrationToken }

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = integrationHeaders): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null)
    return { status: res.status, data }
  } catch (err) {
    return { status: 0, data: { error: (err as Error).message } as T }
  }
}

async function vendor<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${config.vendorUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    return { status: res.status, data: (await res.json().catch(() => null)) as T | null }
  } catch {
    return { status: 0, data: null }
  }
}

// ── State ──────────────────────────────────────────────────────────────────
let simMs = Date.now()
const trains = new Map<string, SimTrain>()
const scenarioLog: { at: number; name: string; note: string }[] = []
const firedScenarios = new Set<string>()
let startSimMs = simMs
let paused = false
let tickCount = 0
const outbox: { batchId: string; readings: Reading[]; attempts: number }[] = []
const heldBack = new Map<string, { batchId: string; readings: Reading[]; attempts: number }>()
let carryDuplicate: Reading | null = null
const stats = { batchesSent: 0, duplicateBatches: 0, reordered: 0, resentReadings: 0, darkBuffered: 0, failures: 0 }

interface BootstrapUnit {
  locomotiveId: string
  model: string
  horsepower: number
  tankGal: number
  modelFactor: number
  role: string
  state: { milepost: number; fuelGal: number; seq: number } | null
}
interface BootstrapTrain {
  id: string
  symbol: string
  routeId: string
  path: string[]
  plannedTons: number
  lastMilepost: number
  units: BootstrapUnit[]
}

/** Hidden truth per train/unit for the scripted scenarios. */
const TRUTH: Record<string, { tonsFactor?: number }> = { T01: { tonsFactor: 1.28 } }

function simUnit(u: BootstrapUnit): SimUnit {
  return {
    id: u.locomotiveId,
    horsepower: u.horsepower,
    tankGal: u.tankGal,
    modelFactorTruth: u.modelFactor * (0.98 + rand() * 0.04),
    fuel: u.state?.fuelGal ?? u.tankGal * 0.7,
    leakGph: 0,
    sensorBias: 0,
    notchDebt: rand(),
    notch: 0,
  }
}

async function bootstrap(): Promise<void> {
  for (;;) {
    const res = await call<{ clock: { simMs: number } | null; trains: BootstrapTrain[] }>('GET', '/api/v1/integrations/sim/bootstrap')
    if (res.status === 200 && res.data) {
      if (res.data.clock) simMs = res.data.clock.simMs
      startSimMs = simMs
      for (const t of res.data.trains) {
        const lead = t.units[0]
        trains.set(
          t.id,
          makeTrain({
            id: t.id,
            symbol: t.symbol,
            routeId: t.routeId,
            path: t.path,
            plannedTons: t.plannedTons,
            milepost: lead?.state?.milepost ?? t.lastMilepost,
            units: t.units.map(simUnit),
            tonsFactor: TRUTH[t.id]?.tonsFactor,
          }),
        )
      }
      logger.info({ trains: trains.size, simTime: new Date(simMs).toISOString() }, 'simulator bootstrapped')
      return
    }
    logger.warn({ status: res.status }, 'waiting for API to bootstrap')
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// ── Crew behaviour ─────────────────────────────────────────────────────────
async function refreshInstructions(t: SimTrain): Promise<void> {
  const res = await call<{ stops: Instruction[] }>('GET', `/api/v1/integrations/trains/${t.id}/instructions`)
  if (res.status === 200 && res.data) {
    t.instructions = res.data.stops
    t.instructionsAt = simMs
  }
}

function startFuelStop(t: SimTrain, ins: Instruction): void {
  const remaining: Record<string, number> = {}
  for (const u of t.units) {
    const target = Math.min(u.tankGal, ins.perUnit.find((p) => p.locomotiveId === u.id)?.targetGal ?? u.fuel)
    remaining[u.id] = Math.max(0, Math.round(target - u.fuel))
  }
  t.state = 'dwelling'
  t.speed = 0
  t.dwell = { kind: 'fuel', instruction: ins, phase: 'setup', until: simMs + ins.setupMinutes * 60_000, remaining, delivered: {}, requested: { ...remaining } }
  logger.info({ train: t.symbol, at: ins.locationId, kind: ins.kind, gallons: Object.values(remaining).reduce((a, b) => a + b, 0) }, 'stopping to fuel')
}

function startTerminal(t: SimTrain): void {
  const remaining: Record<string, number> = {}
  // Terminal service tops units up for the next trip.
  for (const u of t.units) remaining[u.id] = u.fuel < u.tankGal * 0.85 ? Math.round(u.tankGal * 0.92 - u.fuel) : 0
  t.state = 'dwelling'
  t.speed = 0
  t.dwell = { kind: 'terminal', phase: 'setup', until: simMs + 20 * 60_000, remaining, delivered: {} }
}

async function postPadTicket(t: SimTrain, locationId: string, optionId: string, stopKey: string | undefined, pricePerGal: number, delivered: Record<string, number>): Promise<void> {
  const perUnit = Object.entries(delivered)
    .filter(([, g]) => g > 0)
    .map(([locomotiveId, gallons]) => ({ locomotiveId, gallons: Math.round(gallons) }))
  if (perUnit.length === 0) return
  await call('POST', '/api/v1/integrations/fuel-tickets', {
    ticketId: `PAD-${t.id}-${locationId}-${Math.floor(simMs / 60000)}`,
    source: 'pad',
    stopKey,
    trainId: t.id,
    locationId,
    optionId,
    deliveredAt: simMs,
    pricePerGal,
    perUnit,
  })
}

/** Pumps fuel into units at the facility's rate; returns true when done. */
function pump(t: SimTrain, remaining: Record<string, number>, delivered: Record<string, number>, gpm: number, minutes: number): boolean {
  let budget = gpm * minutes
  const open = t.units.filter((u) => (remaining[u.id] ?? 0) > 0)
  for (const u of open) {
    const share = Math.min(remaining[u.id], budget / open.length)
    u.fuel = Math.min(u.tankGal, u.fuel + share)
    remaining[u.id] -= share
    delivered[u.id] = (delivered[u.id] ?? 0) + share
    budget -= share
  }
  return t.units.every((u) => (remaining[u.id] ?? 0) < 1)
}

async function dwellStep(t: SimTrain, minutes: number): Promise<void> {
  const d = t.dwell!
  if (d.kind === 'wait') {
    if (simMs >= d.until) {
      t.state = 'running'
      t.dwell = null
    }
    return
  }
  if (d.phase === 'setup') {
    if (simMs < d.until) return
    if (d.kind === 'fuel' && d.instruction.kind === 'dtl') {
      // The truck only comes for a confirmed order. Ask the vendor to deliver what the plan wants.
      const order = await call<{ stops: Instruction[] }>('GET', `/api/v1/integrations/trains/${t.id}/instructions`)
      const fresh = order.data?.stops.find((s) => s.stopKey === d.instruction.stopKey)
      const vendorId = fresh?.vendorOrderId ?? d.instruction.vendorOrderId
      const res = vendorId
        ? await vendor<{ actual: { locomotiveId: string; gallons: number }[] }>('POST', `/vendor/v1/orders/${vendorId}/deliver`, {
            perUnit: Object.entries(d.requested).map(([locomotiveId, gallons]) => ({ locomotiveId, gallons })),
            deliveredAt: new Date(simMs).toISOString(),
          })
        : { status: 409, data: null }
      if (res.status !== 200 || !res.data) {
        logger.warn({ train: t.symbol, at: d.instruction.locationId }, 'DTL truck no-show; departing unfueled')
        t.dwell = { kind: 'wait', until: simMs + 30 * 60_000 }
        return
      }
      for (const a of res.data.actual) d.remaining[a.locomotiveId] = a.gallons
    }
    d.phase = 'pumping'
  }
  if (d.phase === 'pumping') {
    const gpm = d.kind === 'fuel' ? d.instruction.pumpGpm : 300
    if (pump(t, d.remaining, d.delivered, gpm, minutes)) {
      if (d.kind === 'fuel') {
        if (d.instruction.kind === 'pad') await postPadTicket(t, d.instruction.locationId, d.instruction.optionId, d.instruction.stopKey, d.instruction.pricePerGal, d.delivered)
        d.phase = 'done'
        t.dwell = { kind: 'wait', until: simMs + 5 * 60_000 } // a few minutes to disconnect and air up
      } else {
        const dest = t.path[t.path.length - 1]
        const padOption = FUEL_OPTIONS.find((o) => o.locationId === dest && o.kind === 'pad')
        if (padOption) await postPadTicket(t, dest, padOption.id, undefined, padOption.pricePerGal, d.delivered)
        d.phase = 'settle'
        d.until = simMs + 40 * 60_000
      }
    }
    return
  }
  if (d.kind === 'terminal' && d.phase === 'settle' && simMs >= d.until) {
    t.state = 'arrived'
    t.arrivedAt = simMs
    t.dwell = null
    await call('POST', `/api/v1/integrations/trains/${t.id}/arrive`, { arrivedAt: simMs })
    logger.info({ train: t.symbol }, 'arrived')
  }
}

const REVERSE: Record<string, string> = {
  'TRANSCON-W': 'TRANSCON-E',
  'TRANSCON-E': 'TRANSCON-W',
  'TEXAS-S': 'TEXAS-N',
  'TEXAS-N': 'TEXAS-S',
  'SOUTHERN-W': 'SOUTHERN-E',
  'SOUTHERN-E': 'SOUTHERN-W',
}

async function spawnReturnTrip(t: SimTrain): Promise<void> {
  const routeId = REVERSE[t.routeId] ?? t.routeId
  const route = ROUTES.find((r) => r.id === routeId)!
  const plannedTons = Math.round(6000 + rand() * 5000)
  const symbol = `${t.symbol.split('-')[0]}-${route.path[0]}${route.path[route.path.length - 1]}`
  const res = await call<{ id: string }>('POST', '/api/v1/integrations/trains', {
    symbol,
    routeId,
    plannedTons,
    cars: Math.round(plannedTons / 95),
    units: t.units.map((u) => u.id),
    departedAt: simMs,
  })
  if (res.status !== 201 || !res.data) {
    logger.warn({ status: res.status, data: res.data }, 'could not create return trip')
    return
  }
  trains.delete(t.id)
  const next = makeTrain({ id: res.data.id, symbol, routeId, path: route.path, plannedTons, milepost: 0, units: t.units })
  trains.set(next.id, next)
  logger.info({ train: symbol, id: next.id }, 'new trip departed')
}

// ── Motion ─────────────────────────────────────────────────────────────────
async function moveTrain(t: SimTrain, minutes: number): Promise<number> {
  const hours = minutes / 60
  const leg = t.legs.find((l) => t.milepost >= l.startMile - 1e-6 && t.milepost < l.endMile) ?? t.legs[t.legs.length - 1]
  const target = powerLimitedSpeed(t, leg, leg.speedMph * (0.84 + rand() * 0.14))
  const prevSpeed = t.speed
  const maxDelta = 2.5 * minutes
  t.speed = Math.max(0, prevSpeed + Math.max(-maxDelta, Math.min(maxDelta, target - prevSpeed)))
  const avg = (prevSpeed + t.speed) / 2
  let miles = avg * hours

  const nextIdx = t.nodes.findIndex((n, i) => n.milepost > t.milepost + 1e-6 && !t.handledNodes.has(i))
  if (nextIdx >= 0) {
    const node = t.nodes[nextIdx]
    if (node.milepost - t.milepost < 25 && simMs - t.instructionsAt > 6 * 60_000) await refreshInstructions(t)
    if (t.milepost + miles >= node.milepost) {
      const isDestination = nextIdx === t.nodes.length - 1
      const stop = t.instructions.find((s) => s.locationId === node.locationId)
      if (isDestination || stop) {
        miles = node.milepost - t.milepost
        burn(t, hours, miles)
        t.milepost = node.milepost
        t.handledNodes.add(nextIdx)
        if (isDestination) startTerminal(t)
        else startFuelStop(t, stop!)
        return (t.speed - prevSpeed) / minutes
      }
      t.handledNodes.add(nextIdx)
    }
  }
  burn(t, hours, miles)
  t.milepost = Math.min(t.totalMiles, t.milepost + miles)
  return (t.speed - prevSpeed) / minutes
}

// ── Telemetry delivery with network faults ────────────────────────────────
async function send(batch: { batchId: string; readings: Reading[]; attempts: number }): Promise<boolean> {
  const res = await call('POST', '/api/v1/telemetry/batch', { batchId: batch.batchId, sentAt: simMs, readings: batch.readings }, { 'Content-Type': 'application/json', 'X-Device-Token': config.deviceToken })
  if (res.status === 200 || res.status === 202) {
    stats.batchesSent++
    return true
  }
  stats.failures++
  return false
}

async function deliver(t: SimTrain, readings: Reading[]): Promise<void> {
  if (isDark(t)) {
    t.darkBuffer.push(...readings)
    stats.darkBuffered += readings.length
    return
  }
  const payload = [...t.darkBuffer, ...readings]
  t.darkBuffer = []
  if (config.simulator.faults && carryDuplicate && rand() < 0.5) {
    payload.push(carryDuplicate)
    carryDuplicate = null
    stats.resentReadings++
  }
  const batch = { batchId: randomUUID(), readings: payload, attempts: 0 }
  const held = heldBack.get(t.id)
  if (config.simulator.faults && !held && rand() < 0.03) {
    heldBack.set(t.id, batch) // delivered after this train's next batch: out of order
    stats.reordered++
    return
  }
  outbox.push(batch)
  if (held) {
    outbox.push(held)
    heldBack.delete(t.id)
  }
  if (config.simulator.faults && rand() < 0.04) {
    outbox.push({ ...batch, attempts: 0 }) // same batch id again: a retry after a lost response
    stats.duplicateBatches++
  }
  if (config.simulator.faults && rand() < 0.02) carryDuplicate = payload[payload.length - 1]
}

/** Sends in order, one at a time, so a held-back batch really arrives after newer readings. */
async function flushOutbox(): Promise<void> {
  const pending = outbox.splice(0, outbox.length)
  for (const b of pending) {
    if (!(await send(b)) && b.attempts < 20) outbox.push({ ...b, attempts: b.attempts + 1 })
  }
}

// ── Scenarios ──────────────────────────────────────────────────────────────
function note(name: string, text: string): void {
  scenarioLog.push({ at: simMs, name, note: text })
  firedScenarios.add(name)
  logger.info({ scenario: name }, text)
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  async vendor_timeout() {
    await vendor('PUT', '/vendor/v1/admin/settings', { timeoutNext: 1 })
    note('vendor_timeout', 'Mock vendor will hang on the next DTL order (created, but no response)')
  },
  async leak() {
    const t = trains.get('T03')
    const u = t?.units.find((x) => x.id === '7302')
    if (!u) return note('leak', 'T03/7302 not running; skipped')
    u.leakGph = 90
    note('leak', 'Unit 7302 on S-KCKBAR starts leaking 90 gal/hr')
  },
  async price_change() {
    await call('POST', '/api/v1/integrations/prices', { optionId: 'BEL-PAD', pricePerGal: 3.05, note: 'Supplier contract change at Belen' })
    note('price_change', 'Belen pad price raised from $2.57 to $3.05')
  },
  async sensor_fault() {
    const u = trains.get('T09')?.units.find((x) => x.id === '6260')
    if (!u) return note('sensor_fault', 'T09/6260 not running; skipped')
    u.sensorBias = 450
    note('sensor_fault', 'Fuel sensor on unit 6260 (Z-BARKCK) starts reading +450 gal')
  },
  async reroute() {
    const t = trains.get('T07')
    if (!t) return note('reroute', 'T07 not running; skipped')
    const res = await call<{ path: string[] }>('POST', `/api/v1/integrations/trains/${t.id}/reroute`, { path: DETOUR_FROM_WEL, reason: 'Wellington–Waynoka track outage; detour via Fort Worth' })
    if (res.status === 200 && res.data) {
      setPath(t, res.data.path)
      note('reroute', 'Q-KCKBAR2 rerouted at Wellington via Fort Worth and Slaton (+~420 mi)')
    } else note('reroute', `Reroute refused (${res.status})`)
  },
  async dtl_discount() {
    await call('POST', '/api/v1/integrations/prices', { optionId: 'GAL-DTL', pricePerGal: 2.42, note: 'Mesa Fuel Logistics spot discount at Gallup' })
    note('dtl_discount', 'Gallup DTL spot price cut from $2.97 to $2.42')
  },
  async vendor_reject() {
    await vendor('PUT', '/vendor/v1/admin/settings', { rejectNext: 1 })
    note('vendor_reject', 'Mock vendor will refuse the next DTL order (no truck available)')
  },
  async short_fill() {
    await vendor('PUT', '/vendor/v1/admin/settings', { shortFillPct: 15 })
    note('short_fill', 'DTL deliveries now short-fill 15% against the ticket')
  },
}

/** Scheduled by simulated hours since start, except the reroute, which waits for T07 to pass Emporia. */
const SCHEDULE: { name: string; afterHours: number; when?: () => boolean }[] = [
  { name: 'vendor_timeout', afterHours: 2.9 },
  { name: 'dtl_discount', afterHours: 3 },
  { name: 'leak', afterHours: 1 },
  { name: 'price_change', afterHours: 2 },
  { name: 'sensor_fault', afterHours: 2.5 },
  { name: 'reroute', afterHours: 0, when: () => {
    const t = trains.get('T07')
    return Boolean(t && t.milepost > 112 && t.milepost < 205)
  } },
  { name: 'vendor_reject', afterHours: 4 },
  { name: 'short_fill', afterHours: 6 },
]

async function runScenarios(): Promise<void> {
  if (!config.simulator.scenarios) return
  const hours = (simMs - startSimMs) / 3_600_000
  for (const s of SCHEDULE) {
    if (firedScenarios.has(s.name) || hours < s.afterHours || (s.when && !s.when())) continue
    await SCENARIOS[s.name]()
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  const minutes = (config.simulator.tickMs / 1000) * config.simulator.speedup / 60
  simMs += minutes * 60_000
  tickCount++
  await call('PUT', '/api/v1/integrations/clock', { simMs, speedup: config.simulator.speedup })
  await runScenarios()
  for (const t of [...trains.values()]) {
    let accel = 0
    if (t.state === 'running') accel = await moveTrain(t, minutes)
    else if (t.state === 'dwelling') {
      burn(t, minutes / 60, 0)
      await dwellStep(t, minutes)
    } else if (t.state === 'arrived') {
      if (t.arrivedAt && simMs - t.arrivedAt > 30 * 60_000) await spawnReturnTrip(t)
      continue
    }
    await deliver(t, makeReadings(t, simMs, accel))
  }
  await flushOutbox()
}

async function main(): Promise<void> {
  seedRandom(config.simulator.seed)
  await bootstrap()
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/status', (_req, res) =>
    res.json({
      simTime: new Date(simMs).toISOString(),
      hoursElapsed: Math.round(((simMs - startSimMs) / 3_600_000) * 10) / 10,
      paused,
      tickCount,
      stats,
      scenarios: scenarioLog,
      trains: [...trains.values()].map((t) => ({
        id: t.id,
        symbol: t.symbol,
        state: t.state,
        milepost: Math.round(t.milepost),
        totalMiles: t.totalMiles,
        speed: Math.round(t.speed),
        dark: isDark(t),
        units: t.units.map((u) => ({ id: u.id, fuel: Math.round(u.fuel), notch: u.notch, leakGph: u.leakGph, sensorBias: u.sensorBias })),
      })),
    }),
  )
  app.post('/scenarios/:name', async (req, res) => {
    const fn = SCENARIOS[req.params.name]
    if (!fn) {
      res.status(404).json({ error: 'unknown scenario', known: Object.keys(SCENARIOS) })
      return
    }
    await fn()
    res.json({ ok: true })
  })
  app.post('/pause', (_req, res) => {
    paused = true
    res.json({ paused })
  })
  app.post('/resume', (_req, res) => {
    paused = false
    res.json({ paused })
  })
  const server = app.listen(config.simulatorPort, () => logger.info({ port: config.simulatorPort, speedup: config.simulator.speedup }, 'simulator control listening'))

  let stopped = false
  const loop = async () => {
    const started = Date.now()
    if (!paused) await tick().catch((err) => logger.error({ err }, 'tick failed'))
    if (!stopped) setTimeout(() => void loop(), Math.max(0, config.simulator.tickMs - (Date.now() - started)))
  }
  void loop()
  const shutdown = () => {
    stopped = true
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

await main()
