/**
 * Traffic simulator: virtual storefront visitors driven through the real SDK
 * (the same ExperimentClient the demo app uses), in real time, against a
 * running API. It produces the three results the console demonstrates:
 *
 *   checkout_cta     a real effect: treatment lifts purchase after the product page (significant)
 *   rewards_teaser   no effect, on a tab ~12% of visitors open (assigned ≫ exposed)
 *   shipping_banner  deliberately broken: the treatment logs exposure from a slow image's
 *                    onLoad, and a quarter of visitors leave before it loads → SRM
 *
 * Every visitor's session starts with evaluateAll() (assignment events for
 * every experiment); exposures are logged only on the pages they "render".
 * About a fifth sign in mid-session through /sdk/v1/identify, which returns
 * their stable id (their current anonymous id, on a first sign-in), so their
 * variants do not change. A small cohort replays events from an offline
 * device hours later (late events), one event of which is too old to accept.
 *
 *   npm run simulate                               # 4000 visitors against http://localhost:3001
 *   npm run simulate -- --users 8000 --api http://localhost:3021
 */
import { ExperimentClient } from '../../../sdk/src/client/client.js'
import { uuid } from '../../../sdk/src/client/ids.js'
import type { EvalContext } from '../../../sdk/src/core/types.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (process.env[name.toUpperCase().replace(/-/g, '_')] ?? fallback)
}

const API = arg('api', process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const USERS = Number(arg('users', '4000'))
const CONCURRENCY = Number(arg('concurrency', '200'))
const CLIENT_KEY = arg('client-key', 'cli_prod_4f9a2c7e1b3d5a60')
const SERVER_KEY = arg('server-key', 'srv_prod_9e4a7c2f5b1d3e86')
const SEED = Number(arg('seed', String(Date.now() % 1_000_000)))
const RUN = `r${SEED.toString(36)}`

/** Deterministic behaviour per run (ids stay unique per run). */
let state = SEED >>> 0 || 1
function random(): number {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return (state >>> 0) / 2 ** 32
}
const pick = <T>(items: [T, number][]): T => {
  let r = random()
  for (const [item, p] of items) {
    if ((r -= p) <= 0) return item
  }
  return items[items.length - 1][0]
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = () => sleep(15 + Math.floor(random() * 35))

const P = {
  quickAddPurchase: 0.06, // from the home page, before any product page (not attributable to checkout_cta)
  productPage: 0.45,
  purchaseAfterProduct: { control: 0.09, treatment: 0.135 } as Record<string, number>,
  rewardsTab: 0.12,
  cartPage: 0.4,
  slowImageNeverLoads: 0.25, // shipping_banner treatment only: the exposure never fires
  purchaseAfterCart: 0.05,
  signIn: 0.2,
}

interface Tally {
  assigned: Record<string, Record<string, number>>
  exposed: Record<string, Record<string, number>>
  purchases: number
  lostExposures: number
  signIns: number
}
const tally: Tally = { assigned: {}, exposed: {}, purchases: 0, lostExposures: 0, signIns: 0 }
const bump = (t: Record<string, Record<string, number>>, key: string, variant: string) => {
  t[key] ??= {}
  t[key][variant] = (t[key][variant] ?? 0) + 1
}

const client = new ExperimentClient({
  apiUrl: `${API}/sdk/v1`,
  clientKey: CLIENT_KEY,
  label: `traffic-simulator (${RUN})`,
  sdkInstanceId: `sim_${RUN}`,
  maxBatchSize: 200,
  flushIntervalMs: 500,
  stream: true,
  defaults: { checkout_cta: 'control', rewards_teaser: 'control', shipping_banner: 'control', new_search: 'off' },
})

async function identify(userId: string, anonymousId: string): Promise<string> {
  const res = await fetch(`${API}/sdk/v1/identify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Server-Key': SERVER_KEY }, body: JSON.stringify({ userId, anonymousId }) })
  if (!res.ok) throw new Error(`identify HTTP ${res.status}`)
  return ((await res.json()) as { stableId: string }).stableId
}

function render(key: string, ctx: EvalContext, opts: { lost?: boolean } = {}): string | null {
  const e = client.peek(key, ctx)
  if (!e.inExperiment || !e.variant) return e.variant
  if (opts.lost) {
    tally.lostExposures++
    return e.variant
  }
  if (client.logExposure(e, ctx)) bump(tally.exposed, key, e.variant)
  return e.variant
}

async function visitor(i: number): Promise<void> {
  const anonymousId = `sim_${RUN}_${i}`
  let ctx: EvalContext = {
    anonymousId,
    stableId: anonymousId,
    attributes: {
      country: pick([['US', 0.5], ['CA', 0.15], ['GB', 0.15], ['DE', 0.15], ['FR', 0.05]]),
      plan: pick([['free', 0.7], ['pro', 0.28], ['employee', 0.02]]),
      platform: pick([['web', 0.6], ['ios', 0.25], ['android', 0.15]]),
    },
  }
  // Session start: the app evaluates everything once (assignments, never exposures).
  for (const [key, e] of Object.entries(client.evaluateAll(ctx))) if (e.inExperiment && e.variant) bump(tally.assigned, key, e.variant)
  await step()

  if (random() < P.signIn) {
    const userId = `sim_user_${RUN}_${i}`
    const stableId = await identify(userId, anonymousId)
    ctx = { ...ctx, userId, stableId }
    tally.signIns++
    await step()
  }

  if (random() < P.quickAddPurchase) {
    client.track('purchase', { value: 28 }, ctx)
    tally.purchases++
    await step()
  }

  if (random() < P.productPage) {
    const variant = render('checkout_cta', ctx)
    await step()
    if (random() < (P.purchaseAfterProduct[variant ?? 'control'] ?? P.purchaseAfterProduct.control)) {
      client.track('purchase', { value: 89 }, ctx)
      tally.purchases++
    }
    await step()
  }

  if (random() < P.rewardsTab) {
    render('rewards_teaser', ctx)
    await step()
  }

  if (random() < P.cartPage) {
    const e = client.peek('shipping_banner', ctx)
    render('shipping_banner', ctx, { lost: e.variant === 'treatment' && random() < P.slowImageNeverLoads })
    await step()
    if (random() < P.purchaseAfterCart) {
      client.track('purchase', { value: 59 }, ctx)
      tally.purchases++
    }
  }
}

/** Devices that were offline for hours flush their queue now: late events, one too old to accept. */
async function lateCohort(n: number): Promise<{ accepted: number; rejected: number }> {
  const snapshot = client.getSnapshot()
  const flag = snapshot?.flags.checkout_cta
  if (!flag) return { accepted: 0, rejected: 0 }
  const now = Date.now()
  const events: unknown[] = []
  for (let i = 0; i < n; i++) {
    const anonymousId = `sim_${RUN}_offline_${i}`
    const e = client.peek('checkout_cta', { anonymousId, stableId: anonymousId })
    if (!e.inExperiment || !e.variant) continue
    const at = Math.round(now - (2 + random() * 4) * 3_600_000)
    events.push({ type: 'exposure', eventId: uuid(), ts: at, flagKey: 'checkout_cta', flagVersion: flag.version, variant: e.variant, unitType: 'user', unitId: anonymousId, anonymousId, stableId: anonymousId })
    if (random() < 0.2) events.push({ type: 'conversion', eventId: uuid(), ts: at + 120_000, name: 'purchase', value: 89, anonymousId, stableId: anonymousId })
  }
  events.push({ type: 'conversion', eventId: uuid(), ts: now - 45 * 86_400_000, name: 'purchase', anonymousId: `sim_${RUN}_ancient`, stableId: `sim_${RUN}_ancient` })
  const res = await fetch(`${API}/sdk/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Key': CLIENT_KEY },
    body: JSON.stringify({ batchId: `late_${RUN}`, sentAt: now, sdkInstanceId: `sim_${RUN}_offline`, events }),
  })
  const body = (await res.json()) as { accepted: number; rejected: number }
  return body
}

async function main(): Promise<void> {
  const t0 = Date.now()
  const source = await client.start()
  const snap = client.getSnapshot()
  if (!snap) throw new Error(`no snapshot from ${API} (source: ${source}); is the API running?`)
  console.log(`simulating ${USERS} visitors against ${API} (snapshot v${snap.version}, run ${RUN})`)
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, USERS) }, async () => {
    while (next < USERS) {
      const i = next++
      await visitor(i)
      if (i > 0 && i % 1000 === 0) console.log(`  ${i} visitors…`)
    }
  })
  await Promise.all(workers)
  const late = await lateCohort(Math.max(20, Math.round(USERS * 0.03)))
  await client.flush()
  await client.close()
  const stats = (client as unknown as { queue: { stats: { sent: number; dropped: number } } }).queue.stats
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stats.sent} events sent, ${stats.dropped} dropped, ${tally.purchases} purchases, ${tally.signIns} sign-ins`)
  console.log(`late cohort (offline devices flushing hours later): ${late.accepted} accepted, ${late.rejected} rejected`)
  for (const key of ['checkout_cta', 'rewards_teaser', 'shipping_banner']) {
    const a = tally.assigned[key] ?? {}
    const x = tally.exposed[key] ?? {}
    console.log(`  ${key.padEnd(16)} assigned ${JSON.stringify(a)}  exposed ${JSON.stringify(x)}`)
  }
  console.log(`  shipping_banner treatment exposures lost to the slow-image bug: ${tally.lostExposures}`)
  console.log('Results appear once the ingest worker drains the stream (about a second).')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
