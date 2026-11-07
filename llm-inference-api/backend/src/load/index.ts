/**
 * Load generator: several tenants against the public API, including a noisy
 * bulk tenant, to show fairness, 429 vs 529, and batch fill at low and high
 * traffic. Usage:
 *
 *   npm run load                                   # all phases, ~60 s
 *   npm run load -- --phases low,high              # pick phases
 *   npm run load -- --gateway http://localhost:3001 --scale 2
 *
 * Phases:
 *   low       one tenant at ~1.5 req/s: batches leave on max_wait, mostly size 1
 *   high      four tenants, a noisy bulk flood among them: full batches, fair
 *             dispatch, the free tier hitting 429
 *   capacity  two of three backends drained (needs the admin login): the
 *             interactive queue reaches its bound and new work gets 529
 * The API keys are the seeded local secrets (see src/db/seed.ts).
 */
import { KEYS } from '../db/fixtures.js'

const args = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const GATEWAY = arg('gateway', process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 3000}`)
const PHASES = arg('phases', 'low,high,capacity').split(',')
const SCALE = Number(arg('scale', '1'))
const secret = (org: string) => (KEYS.find((k) => k.org === org) as { secret: string }).secret

const PROMPTS: Record<string, string[]> = {
  acme: [
    'You are the Acme Robotics support assistant. Answer from the manual and cite the section. ' + 'Manual excerpt: calibrate the arm before each shift. '.repeat(90),
    'You are the Acme Robotics release-notes writer. Keep entries short and factual. ' + 'Changelog style guide: one line per change. '.repeat(80),
  ],
  globex: ['You summarize Globex research notes into three bullets and one open question. ' + 'Lab notebook conventions apply. '.repeat(100)],
  initech: ['You are a hack-day helper for Initech. ' + 'Be brief. '.repeat(40)],
  umbrella: [
    'You classify Umbrella documents into twelve categories and justify the label in one sentence. ' + 'Category definitions follow. '.repeat(120),
    'You extract named entities from Umbrella archive scans. ' + 'Entity schema follows. '.repeat(110),
  ],
}

interface Stat {
  sent: number
  ok: number
  r429: number
  r529: number
  other: number
  queue: number[]
  ttft: number[]
}
const stats = new Map<string, Stat>()
const stat = (k: string): Stat => {
  let s = stats.get(k)
  if (!s) {
    s = { sent: 0, ok: 0, r429: 0, r529: 0, other: 0, queue: [], ttft: [] }
    stats.set(k, s)
  }
  return s
}

const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]
let inflight = 0

async function fire(org: string, mode: 'sync' | 'stream' | 'async', maxTokens: number, out: number, label = org): Promise<void> {
  const s = stat(label)
  s.sent++
  inflight++
  const body = {
    model: 'mock-large',
    max_tokens: maxTokens,
    system: pick(PROMPTS[org]),
    messages: [{ role: 'user', content: `Request ${Math.random().toString(36).slice(2)}` }],
    stream: mode === 'stream',
    metadata: { mock_output_tokens: out },
  }
  try {
    const r = await fetch(`${GATEWAY}/v1/messages${mode === 'async' ? '/async' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': secret(org) },
      body: JSON.stringify(body),
    })
    if (r.status === 429) s.r429++
    else if (r.status === 529) s.r529++
    else if (r.status >= 200 && r.status < 300) {
      s.ok++
      if (mode === 'sync') {
        await r.json()
        s.queue.push(Number(r.headers.get('x-inference-queue-ms')))
        s.ttft.push(Number(r.headers.get('x-inference-ttft-ms')))
      } else if (mode === 'stream') {
        const text = await r.text()
        const m = text.match(/"status":"running".*?"queueMs":(\d+),"ttftMs":(\d+)/)
        if (m) {
          s.queue.push(Number(m[1]))
          s.ttft.push(Number(m[2]))
        }
      } else await r.json()
    } else {
      s.other++
      await r.text()
    }
  } catch {
    s.other++
  } finally {
    inflight--
  }
}

/** Fires `rps` requests per second for `seconds`, without waiting for responses. */
async function drive(seconds: number, lanes: { rps: number; run: () => Promise<void> }[]): Promise<void> {
  const end = Date.now() + seconds * 1000
  const timers = lanes.map((lane) => {
    const every = 1000 / (lane.rps * SCALE)
    return setInterval(() => void lane.run(), every)
  })
  while (Date.now() < end) await sleep(250)
  for (const t of timers) clearInterval(t)
}

let cookie = ''
async function adminLogin(): Promise<boolean> {
  const r = await fetch(`${GATEWAY}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password123' }) })
  cookie = r.headers.get('set-cookie')?.split(';')[0] ?? ''
  return r.ok
}
async function adminCall(method: string, path: string, payload?: unknown) {
  const r = await fetch(`${GATEWAY}/api/v1/admin${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: payload ? JSON.stringify(payload) : undefined })
  return r.json().catch(() => null)
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return '-'
  const s = [...xs].sort((a, b) => a - b)
  return String(s[Math.min(s.length - 1, Math.floor(p * s.length))])
}

function report(title: string): void {
  console.log(`\n${title}`)
  console.log('tenant/lane            sent   2xx   429   529  other   queue p50/p95 ms   ttft p50 ms')
  for (const [k, s] of stats) {
    console.log(
      `${k.padEnd(20)} ${String(s.sent).padStart(6)} ${String(s.ok).padStart(5)} ${String(s.r429).padStart(5)} ${String(s.r529).padStart(5)} ${String(s.other).padStart(6)}   ${`${pct(s.queue, 0.5)}/${pct(s.queue, 0.95)}`.padStart(16)}   ${pct(s.ttft, 0.5).padStart(10)}`,
    )
  }
  stats.clear()
}

async function batchSummary(): Promise<void> {
  const ov = (await adminCall('GET', '/overview')) as { batches?: { summary: { priorityClass: string; trigger: string; count: number; avgFill: number; avgSize: number }[] } } | null
  if (!ov?.batches) return
  console.log('\nbatches (last 10 min)   class        trigger    count  avg size  avg fill')
  for (const b of ov.batches.summary) {
    console.log(`                        ${b.priorityClass.padEnd(12)} ${b.trigger.padEnd(10)} ${String(b.count).padStart(5)}  ${String(b.avgSize).padStart(8)}  ${(b.avgFill * 100).toFixed(0).padStart(7)}%`)
  }
}

async function main(): Promise<void> {
  const ok = await fetch(`${GATEWAY}/health`).then((r) => r.ok).catch(() => false)
  if (!ok) {
    console.error(`Gateway ${GATEWAY} is not reachable. Start the stack first (npm run dev).`)
    process.exit(1)
  }
  const isAdmin = await adminLogin()
  console.log(`Load generator → ${GATEWAY} (phases: ${PHASES.join(', ')}, scale ${SCALE})`)

  if (PHASES.includes('low')) {
    console.log('\n[low] Acme alone at ~1.5 req/s for 10 s: a batch never fills, so each one leaves on max_wait')
    await drive(10, [{ rps: 1.5, run: () => fire('acme', 'sync', 128, rand(10, 30), 'acme (sync)') }])
    await sleep(1500)
    report('[low] results')
  }

  if (PHASES.includes('high')) {
    console.log('\n[high] 20 s: Acme and Globex interactive, Initech over its free tier, Umbrella flooding bulk work')
    await drive(20, [
      { rps: 5, run: () => fire('acme', 'stream', 256, rand(20, 60), 'acme (stream)') },
      { rps: 3, run: () => fire('acme', 'sync', 256, rand(10, 30), 'acme (sync)') },
      { rps: 4, run: () => fire('globex', 'sync', 256, rand(20, 50), 'globex (sync)') },
      { rps: 2, run: () => fire('initech', 'sync', 1200, rand(300, 600), 'initech (free)') },
      { rps: 25, run: () => fire('umbrella', 'async', 512, rand(40, 120), 'umbrella (bulk)') },
    ])
    while (inflight > 0) await sleep(250)
    report('[high] results (umbrella is async: its queue/ttft show in the admin console)')
  }

  if (PHASES.includes('capacity')) {
    if (!isAdmin) console.log('\n[capacity] skipped: admin login failed')
    else {
      console.log('\n[capacity] 12 s with b2 and b3 drained: 8 slots left, the interactive queue fills to its bound → 529')
      await adminCall('POST', '/backends/b2/drain', { draining: true })
      await adminCall('POST', '/backends/b3/drain', { draining: true })
      await sleep(800)
      try {
        await drive(12, [
          { rps: 12, run: () => fire('acme', 'sync', 256, rand(40, 80), 'acme (sync)') },
          { rps: 8, run: () => fire('umbrella', 'sync', 256, rand(40, 80), 'umbrella (sync)') },
          { rps: 6, run: () => fire('globex', 'sync', 256, rand(40, 80), 'globex (sync)') },
        ])
      } finally {
        await adminCall('POST', '/backends/b2/drain', { draining: false })
        await adminCall('POST', '/backends/b3/drain', { draining: false })
      }
      while (inflight > 0) await sleep(250)
      report('[capacity] results (429 = a tenant at its own queue share; 529 = the class queue is full)')
    }
  }

  if (isAdmin) await batchSummary()
}

await main()
