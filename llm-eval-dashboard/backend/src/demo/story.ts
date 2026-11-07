/**
 * Drives the live pipeline through the interesting states, narrating as it
 * goes. Needs the API, two workers, the mock model and the mock judge running
 * (`npm run dev`), and a seeded database. About a minute.
 *
 *   npm run demo:story            # API_URL / MODEL_URL default to the repo ports
 *
 * 1. Idempotent creation: the same Idempotency-Key twice → one run.
 * 2. Chaos: 429s, an overload and a mid-stream disconnect are retried.
 * 3. Permanent errors → "completed, 2 errored", then "retry errored".
 * 4. Re-score with a fixed regex: new scores, zero model calls.
 * 5. Cancel a slow run mid-flight: model calls stop within a second.
 */
const API = `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1`
const MODEL = process.env.MODEL_URL ?? 'http://localhost:3100'
let cookie = ''

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  const data = (await res.json().catch(() => ({}))) as T
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}
const mock = (method: string, path: string, body?: unknown) =>
  fetch(`${MODEL}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<{ total: number; run: { active: number; calls: number } }>)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const say = (msg: string) => console.log(`\n▶ ${msg}`)

type Detail = { run: { id: string; status: string; name: string }; progress: Record<string, number>; usage: { modelCalls: number }; scorers: { name: string; version: number; coverage: { pending: number }; aggregate: { mean: number | null; ciHalfWidth: number | null; erroredTasks: number } }[] }

async function waitDone(id: string): Promise<Detail> {
  for (;;) {
    const d = await call<Detail>('GET', `/runs/${id}`)
    if (['completed', 'failed', 'cancelled'].includes(d.run.status) && d.scorers.every((s) => s.coverage.pending === 0)) return d
    await sleep(500)
  }
}
function report(d: Detail) {
  const p = d.progress
  console.log(`  ${d.run.name}: ${d.run.status} · ${p.succeeded} succeeded, ${p.errored} errored, ${p.cancelled} cancelled · ${d.usage.modelCalls} model calls`)
  for (const s of d.scorers) {
    const a = s.aggregate
    console.log(`    ${s.name} v${s.version}: ${a.mean === null ? '—' : a.mean.toFixed(3)} ± ${a.ciHalfWidth === null ? '—' : a.ciHalfWidth.toFixed(3)} (${a.erroredTasks} errored excluded)`)
  }
}

const triage = { datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_1', modelConfigId: 'mc_small_t07' }
await call('POST', '/auth/login', { username: 'alice', password: 'password123' })
await mock('POST', '/admin/chaos/reset')
await mock('PUT', '/admin/settings', { latencyMultiplier: 1 })

say('1. Idempotent creation: the same request twice with one Idempotency-Key')
const key = `demo-${Date.now()}`
const body = { ...triage, name: 'Demo: triage v1 with chaos', scorerVersionIds: ['scv_contains_1', 'scv_regex_1'], samplesPerCase: 3, concurrencyLimit: 4 }
await mock('PUT', '/admin/chaos', { armed: { rate_limit: 3, overloaded: 1, disconnect: 1 } })
const first = await call<{ run: { id: string }; replayed: boolean }>('POST', '/runs', body, { 'Idempotency-Key': key })
const second = await call<{ run: { id: string }; replayed: boolean }>('POST', '/runs', body, { 'Idempotency-Key': key })
console.log(`  first: ${first.run.id} (replayed=${first.replayed}); retry: ${second.run.id} (replayed=${second.replayed})`)

say('2. Chaos armed: 3 × 429, 1 × overload, 1 × mid-stream disconnect; each task retries with backoff')
const d1 = await waitDone(first.run.id)
report(d1)
console.log('  The long log case (t-023) exceeds mock-small\'s context window: a permanent error, tried once, shown as errored.')

say('3. Permanent errors: 2 × invalid request on a fresh run, then "retry errored"')
await mock('PUT', '/admin/chaos', { armed: { invalid: 2 } })
const r3 = await call<{ run: { id: string } }>('POST', '/runs', { datasetVersionId: 'dsv_orders_1', promptVersionId: 'pv_orders_2', modelConfigId: 'mc_small_t07', name: 'Demo: orders with 2 errored', scorerVersionIds: ['scv_json_2'], samplesPerCase: 1 }, { 'Idempotency-Key': `demo-orders-${Date.now()}` })
report(await waitDone(r3.run.id))
const retried = await call<{ requeued: number }>('POST', `/runs/${r3.run.id}/retry-errored`)
console.log(`  retry errored: re-queued ${retried.requeued} tasks (successful ones untouched)`)
report(await waitDone(r3.run.id))

say('4. Re-score the first run with the fixed regex (v2): stored outputs only')
const before = (await mock('GET', '/admin/stats')).total
const rescore = await call<{ queued: number }>('POST', `/runs/${first.run.id}/rescore`, { scorerVersionId: 'scv_regex_2' })
const d4 = await waitDone(first.run.id)
const after = (await mock('GET', '/admin/stats')).total
console.log(`  queued ${rescore.queued} score tasks; mock model calls ${before} → ${after} (zero new generations)`)
report(d4)

say('5. Cancel a slow run mid-flight')
await mock('PUT', '/admin/settings', { latencyMultiplier: 6 })
const r5 = await call<{ run: { id: string } }>('POST', '/runs', { ...triage, modelConfigId: 'mc_large_t07', name: 'Demo: cancelled mid-run', scorerVersionIds: ['scv_contains_1'], samplesPerCase: 5 }, { 'Idempotency-Key': `demo-cancel-${Date.now()}` })
for (;;) {
  const d = await call<Detail>('GET', `/runs/${r5.run.id}`)
  if (d.progress.succeeded >= 6) break
  await sleep(300)
}
const cancelledAt = Date.now()
await call('POST', `/runs/${r5.run.id}/cancel`)
for (;;) {
  const s = await mock('GET', `/admin/stats?runId=${r5.run.id}`)
  if (s.run.active === 0) break
  await sleep(50)
}
console.log(`  in-flight model calls stopped ${Date.now() - cancelledAt} ms after cancel`)
await mock('PUT', '/admin/settings', { latencyMultiplier: 1 })
report(await waitDone(r5.run.id))

say('Done. Open the runs list, compare "Triage v1 baseline" with "Triage v2", and try the annotation queue on "Status v1".')
