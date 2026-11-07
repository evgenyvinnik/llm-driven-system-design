/**
 * Isolation demo: two customers emit events at the same rate; halfway through,
 * Globex's main endpoint starts hanging (accepts the connection, never
 * answers in time). Acme's delivery latency should stay flat, because Globex's
 * endpoint can only ever hold its own in-flight limit of requests and its
 * backlog waits in PostgreSQL, not in the shared queue or in workers.
 *
 *   npm run demo:load -- [--seconds 40] [--rate 8] [--mode slow|error500] [--keep-down]
 *
 * Latency = event committed → acme-billing delivery marked delivered, read
 * from PostgreSQL. Globex numbers show how much of its work is parked.
 */
import { pool } from '../shared/db.js'
import { call, emit, login, sleep } from './client.js'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const seconds = Number(arg('seconds', '40'))
const rate = Number(arg('rate', '8'))
const mode = arg('mode', 'slow')
const keepDown = process.argv.includes('--keep-down')

const bob = await login('bob')
const admin = await login('admin')
await call('PUT', '/receiver/paths/globex-main', { cookie: bob, body: { mode: 'ok' } })
await call('POST', '/endpoints/ep_globex_main/enable', { cookie: bob })

const pctl = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function phase(label: string, secs: number): Promise<{ label: string; acme: number[]; acmeIds: string[]; globexIds: string[] }> {
  const acmeIds: string[] = []
  const globexIds: string[] = []
  const end = Date.now() + secs * 1000
  let tick = 0
  while (Date.now() < end) {
    const started = Date.now()
    await Promise.all([
      emit('acme', 'invoice.paid', { invoiceId: `in_load_${label}_${tick}`, amount: 100 }).then((r) => acmeIds.push(r.event.id)),
      emit('globex', 'order.created', { orderId: `g_load_${label}_${tick}`, amount: 100 }).then((r) => globexIds.push(r.event.id)),
    ])
    tick++
    if (tick % (rate * 5) === 0) {
      const ops = await call('GET', '/ops/overview', { cookie: admin })
      const g = ops.endpoints.find((e: { id: string }) => e.id === 'ep_globex_main')
      const acme = ops.orgs.find((o: { org: string }) => o.org === 'Acme Corp')
      console.log(`  [${label}] t=${Math.round((secs * 1000 - (end - Date.now())) / 1000)}s  acme event→delivered p50 ${acme?.eventToDeliveredP50Ms ?? '—'} ms  ·  globex-main slots ${g.slotsHeld}/${g.effectiveConcurrency}, queued ${g.queued}, waiting in DB ${g.scheduled}  ·  queue ready ${ops.queue.ready}`)
    }
    await sleep(Math.max(0, 1000 / rate - (Date.now() - started)))
  }
  await sleep(2000)
  const { rows } = await pool.query<{ ms: number }>(
    `SELECT EXTRACT(EPOCH FROM d.delivered_at - e.created_at) * 1000 AS ms FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.event_id = ANY($1) AND d.endpoint_id = 'ep_acme_billing' AND d.state = 'delivered'`,
    [acmeIds],
  )
  return { label, acme: rows.map((r) => Number(r.ms)), acmeIds, globexIds }
}

console.log(`Phase 1: both customers healthy (${seconds / 2}s at ${rate} events/s each)`)
const healthy = await phase('healthy', seconds / 2)
console.log(`Phase 2: globex-main ${mode === 'slow' ? 'hangs (answers after 30 s, past the delivery timeout)' : 'returns 500'} (${seconds / 2}s)`)
await call('PUT', '/receiver/paths/globex-main', { cookie: bob, body: mode === 'slow' ? { mode: 'slow', slowMs: 30_000, remaining: null } : { mode: 'error500', remaining: null } })
const down = await phase('globex-down', seconds / 2)

const { rows: g } = await pool.query<{ state: string; n: number }>(
  `SELECT state, count(*)::int AS n FROM deliveries WHERE endpoint_id = 'ep_globex_main' AND event_id = ANY($1) GROUP BY state ORDER BY state`,
  [down.globexIds],
)
console.log('\nAcme (healthy customer), event committed → delivered:')
console.table(
  [healthy, down].map((p) => ({
    phase: p.label,
    delivered: `${p.acme.length}/${p.acmeIds.length}`,
    p50_ms: Math.round(pctl(p.acme, 50)),
    p95_ms: Math.round(pctl(p.acme, 95)),
    max_ms: Math.round(Math.max(...p.acme)),
  })),
)
console.log(`Globex-main deliveries from phase 2: ${g.map((r) => `${r.state} ${r.n}`).join(', ')}`)
if (!keepDown) {
  await call('PUT', '/receiver/paths/globex-main', { cookie: bob, body: { mode: 'ok' } })
  console.log('globex-main restored; its waiting deliveries drain at its own concurrency limit.')
}
await pool.end()
