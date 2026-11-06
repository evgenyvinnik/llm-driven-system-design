/**
 * Simulator: runs the scripted afternoon (see scenario.ts) against the ingest
 * API in real time. Gateways flush every second, the PTC feed every 5 s.
 *
 *   npm run simulate                      # full scenario, ~7 minutes, then exits
 *   npm run simulate -- --duration 900    # keep the background running longer
 *   npm run simulate -- --background      # trains and readings only, no incidents
 */
import { config } from '../shared/config.js'
import { SCENARIO, TRAINS } from './scenario.js'
import { World } from './world.js'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) || fallback : fallback
}

const duration = arg('duration', 420)
const scripted = !process.argv.includes('--background')
const world = new World(TRAINS.map((t) => ({ ...t })))
const steps = scripted ? [...SCENARIO] : []
const log = (msg: string) => console.log(`[sim ${world.t().toFixed(1).padStart(6)}s] ${msg}`)

log(`posting to ${config.apiUrl}; ${scripted ? `${steps.length} scripted steps` : 'background only'}; duration ${duration}s`)
let last = Date.now()
let lastFlush = 0
let lastPtc = 0
let lastStatus = 0

const timer = setInterval(() => {
  const now = new Date()
  const dt = (now.getTime() - last) / 1000
  last = now.getTime()
  const t = world.t()
  while (steps.length && steps[0].at <= t) {
    const step = steps.shift()!
    log(step.label)
    step.run(world)
  }
  world.moveTrains(dt)
  world.readings(now)
  if (now.getTime() - lastFlush >= 1000) {
    lastFlush = now.getTime()
    void world.flushGateways()
  }
  if (now.getTime() - lastPtc >= 5000) {
    lastPtc = now.getTime()
    void world.reportTrains(now)
  }
  if (now.getTime() - lastStatus >= 30_000) {
    lastStatus = now.getTime()
    const offline = [...world.gateways.values()].filter((g) => !g.online).map((g) => g.id)
    log(`trains ${world.trains.map((tr) => `${tr.symbol}@${tr.milepost.toFixed(1)}`).join(' ')} | buffered ${world.pendingEdgeEvents()}${offline.length ? ` | offline ${offline.join(',')}` : ''}`)
  }
  if (t >= duration) void finish()
}, 250)

let finishing = false
async function finish(): Promise<void> {
  if (finishing) return
  finishing = true
  clearInterval(timer)
  for (const g of world.gateways.values()) g.online = true
  world.ptcGaps.clear()
  for (let i = 0; i < 20 && world.pendingEdgeEvents() > 0; i++) {
    await world.flushGateways()
    await world.reportTrains(new Date())
    await new Promise((r) => setTimeout(r, 500))
  }
  const dupes = [...world.gateways.values()].reduce((n, g) => n + g.duplicatesReported, 0)
  log(`done; ${world.pendingEdgeEvents()} events left buffered; ingest reported ${dupes} duplicates`)
  process.exit(0)
}

process.on('SIGINT', () => void finish())
process.on('SIGTERM', () => void finish())
