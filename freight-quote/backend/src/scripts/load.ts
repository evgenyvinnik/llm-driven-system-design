/**
 * Load scenarios against a running stack (API, deps, completer). Each one
 * runs twice, with a mechanism off and then on, and prints a markdown table.
 *
 *   npm run load -- hedging      capacity has a 5% slow tail; p99 with and without hedged requests
 *   npm run load -- coalescing   bursts of identical requests against a capacity service with 4 workers
 *   npm run load -- storm        integrations re-quote in a tight retry loop while two portal users quote
 *   npm run load -- all
 *
 * It changes settings and knobs through the ops API (as omar) and restores
 * the defaults at the end. Numbers depend on the machine; the docs quote one run.
 */
import { randomUUID } from 'node:crypto'
import { config } from '../shared/config.js'
import { CUSTOMERS, LANES, COMMODITIES, weekStart } from '../shared/reference.js'
import { percentile } from '../shared/resilience.js'

const API = `${config.apiUrl}/api/v1`
const KEYS = CUSTOMERS.filter((c) => c.apiKey).map((c) => c.apiKey as string)
const SHIP_WEEK = weekStart(new Date(Date.now() + 14 * 86_400_000))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function login(username: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }) })
  const cookie = res.headers.get('set-cookie')
  if (!res.ok || !cookie) throw new Error(`login ${username} failed: ${res.status}`)
  return cookie.split(';')[0]
}

let ops = ''
async function opsCall(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', cookie: ops }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const settings = (patch: unknown) => opsCall('/ops/settings', 'PUT', patch)
const knobs = (dep: string, patch: unknown) => opsCall(`/ops/knobs/${dep}`, 'PUT', patch)
async function depCalls(dep: string): Promise<number> {
  const s = (await opsCall('/ops/overview', 'GET')) as { depStats: { stats: Record<string, { calls: number }> } }
  return s.depStats.stats[dep].calls
}
async function resetAll(): Promise<void> {
  await opsCall('/ops/settings/reset', 'POST')
  await opsCall('/ops/knobs/reset', 'POST')
  await opsCall('/ops/stats/reset', 'POST')
}

interface Spec {
  auth: { apiKey: string } | { cookie: string }
  body: Record<string, unknown>
}
interface Result {
  status: number
  ms: number
  kind: string | null
}

async function send(spec: Spec, timeoutMs = 10_000): Promise<Result> {
  const t0 = performance.now()
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': `load-${randomUUID()}` }
    if ('apiKey' in spec.auth) headers['x-api-key'] = spec.auth.apiKey
    else headers.cookie = spec.auth.cookie
    const res = await fetch(`${API}/quotes`, { method: 'POST', headers, body: JSON.stringify(spec.body), signal: AbortSignal.timeout(timeoutMs) })
    const json = (await res.json().catch(() => ({}))) as { quote?: { kind?: string } }
    return { status: res.status, ms: performance.now() - t0, kind: json.quote?.kind ?? null }
  } catch {
    return { status: 0, ms: performance.now() - t0, kind: null }
  }
}

function randomBody(): Record<string, unknown> {
  const lane = LANES[Math.floor(Math.random() * LANES.length)]
  const commodity = COMMODITIES[Math.floor(Math.random() * COMMODITIES.length)]
  return { origin: lane.origin, destination: lane.destination, commodity: commodity.code, equipment: commodity.equipment[0], quantity: 1 + Math.floor(Math.random() * 200), shipWeek: SHIP_WEEK }
}

function summarize(results: Result[]) {
  const ok = results.filter((r) => r.status >= 200 && r.status < 300)
  const ms = ok.map((r) => r.ms)
  const p = (q: number) => Math.round(percentile(ms, q) ?? 0)
  return {
    n: results.length,
    p50: p(50),
    p95: p(95),
    p99: p(99),
    firmPct: ok.length ? Math.round((ok.filter((r) => r.kind === 'firm').length / ok.length) * 100) : 0,
    shed: results.filter((r) => r.status === 503).length,
    limited: results.filter((r) => r.status === 429).length,
    errors: results.filter((r) => r.status === 0 || r.status >= 500).length,
  }
}

async function closedLoop(workers: number, count: number, make: () => Spec): Promise<Result[]> {
  const out: Result[] = []
  let issued = 0
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (issued < count) {
        issued += 1
        out.push(await send(make()))
      }
    }),
  )
  return out
}

const isolate = { shedding: { enabled: false }, rateLimits: { enabled: false } }

async function hedgingScenario(): Promise<string> {
  await resetAll()
  for (const dep of ['pricing', 'fuel', 'availability']) await knobs(dep, { tailPct: 0 })
  await knobs('capacity', { latencyMs: 80, jitterPct: 20, tailPct: 5, tailMs: 1_500, concurrency: 1_000 })
  const rows: string[] = []
  for (const hedge of [false, true]) {
    await settings({ ...isolate, coalescing: false, deadlineMs: 3_000, budgets: { pricing: 2_500, fuel: 2_500, capacity: 2_500, availability: 2_500 }, hedging: { enabled: hedge, deps: ['capacity'], percentile: 90, minDelayMs: 60, budgetPct: 15 } })
    await closedLoop(8, 60, () => ({ auth: { apiKey: KEYS[0] }, body: randomBody() })) // warm caches and the latency window
    const before = await depCalls('capacity')
    const results = await closedLoop(8, 600, () => ({ auth: { apiKey: KEYS[0] }, body: randomBody() }))
    const calls = (await depCalls('capacity')) - before
    const s = summarize(results)
    rows.push(`| ${hedge ? 'on' : 'off'} | ${s.n} | ${s.p50} | ${s.p95} | ${s.p99} | ${(calls / s.n).toFixed(2)} |`)
  }
  return ['### Hedged requests (capacity: 80 ms median, 5% of calls take 1.5 s)', '', '| Hedging | Requests | p50 ms | p95 ms | p99 ms | Capacity calls per quote |', '|---|---|---|---|---|---|', ...rows].join('\n')
}

async function coalescingScenario(): Promise<string> {
  await resetAll()
  await knobs('capacity', { latencyMs: 200, jitterPct: 10, tailPct: 0, concurrency: 4 })
  await knobs('availability', { latencyMs: 100, tailPct: 0, concurrency: 4 })
  const rows: string[] = []
  for (const coalesce of [false, true]) {
    await settings({ ...isolate, coalescing: coalesce, hedging: { enabled: false } })
    const before = await depCalls('capacity')
    const results: Result[] = []
    for (let round = 0; round < 10; round += 1) {
      const body = { ...randomBody(), quantity: 50 + round }
      results.push(...(await Promise.all(Array.from({ length: 40 }, (_, i) => send({ auth: { apiKey: KEYS[i % KEYS.length] }, body })))))
      await sleep(300)
    }
    const calls = (await depCalls('capacity')) - before
    const s = summarize(results)
    rows.push(`| ${coalesce ? 'on' : 'off'} | ${s.n} | ${s.p50} | ${s.p99} | ${s.firmPct}% | ${calls} |`)
  }
  return ['### Request coalescing (10 bursts of 40 identical requests; capacity has 4 workers at 200 ms)', '', '| Coalescing | Requests | p50 ms | p99 ms | Firm | Capacity calls |', '|---|---|---|---|---|---|', ...rows].join('\n')
}

async function stormScenario(): Promise<string> {
  await resetAll()
  await knobs('capacity', { latencyMs: 150, jitterPct: 10, tailPct: 0, concurrency: 6 })
  await knobs('availability', { latencyMs: 90, tailPct: 0, concurrency: 8 })
  const portalCookie = await login('pat')
  const rows: string[] = []
  const variants: { label: string; patch: Record<string, unknown> }[] = [
    { label: 'off', patch: { shedding: { enabled: false }, rateLimits: { enabled: false } } },
    { label: 'shedding', patch: { shedding: { enabled: true, maxInflight: 24 }, rateLimits: { enabled: false } } },
    { label: 'shedding + rate limits', patch: { shedding: { enabled: true, maxInflight: 24 }, rateLimits: { enabled: true, portalPerMinute: 600 } } },
  ]
  for (const v of variants) {
    await settings({ ...v.patch, coalescing: false, hedging: { enabled: false } })
    await opsCall('/ops/stats/reset', 'POST')
    const before = await depCalls('capacity')
    const stopAt = Date.now() + 12_000
    const portal: Result[] = []
    const storm: Result[] = []
    const portalUsers = Array.from({ length: 2 }, async () => {
      while (Date.now() < stopAt) {
        portal.push(await send({ auth: { cookie: portalCookie }, body: { ...randomBody(), origin: 'KCK', destination: 'CHI', commodity: 'GRAIN', equipment: 'COVERED_HOPPER' } }))
        await sleep(250)
      }
    })
    // A badly behaved integration: each worker re-quotes its own lane in a loop and retries at once on any error.
    const stormers = Array.from({ length: 60 }, async (_, i) => {
      const body = { ...randomBody(), quantity: 1 + (i % 200) }
      while (Date.now() < stopAt) storm.push(await send({ auth: { apiKey: KEYS[i % KEYS.length] }, body }, 5_000))
    })
    await Promise.all([...portalUsers, ...stormers])
    const calls = (await depCalls('capacity')) - before
    const p = summarize(portal)
    const s = summarize(storm)
    rows.push(`| ${v.label} | ${p.n} | ${p.p50} | ${p.p99} | ${p.firmPct}% | ${p.shed + p.errors} | ${s.n} | ${s.shed} | ${s.limited} | ${calls} |`)
    await sleep(1_500)
  }
  return [
    '### Retry storm (60 integration workers re-quote with no backoff; 2 portal users; capacity has 6 workers at 150 ms)',
    '',
    '| Protection | Portal requests | Portal p50 ms | Portal p99 ms | Portal firm | Portal failed | Storm requests | Shed (503) | Rate-limited (429) | Capacity calls |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

async function main(): Promise<void> {
  const which = process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'all'
  ops = await login('omar')
  const out: string[] = []
  try {
    if (which === 'hedging' || which === 'all') out.push(await hedgingScenario())
    if (which === 'coalescing' || which === 'all') out.push(await coalescingScenario())
    if (which === 'storm' || which === 'all') out.push(await stormScenario())
  } finally {
    await resetAll()
  }
  console.log(`\nLoad results (${new Date().toISOString()})\n`)
  console.log(out.join('\n\n'))
}

await main()
