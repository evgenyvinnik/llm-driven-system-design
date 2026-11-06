/**
 * Mock dependency services in one process, one route per dependency, each
 * with its own knobs (latency, tail, errors, hangs, concurrency, down):
 *
 *   POST /pricing/rate         tariff or contract linehaul (versioned)
 *   POST /fuel/surcharge       weekly fuel surcharge (versioned by effective date)
 *   POST /capacity/check       lane utilization and capacity premium (perishable)
 *   POST /availability/check   car supply at origin (perishable)
 *
 * Each honours the caller's propagated deadline (X-Deadline, epoch ms): work
 * stops at the deadline and the worker slot is freed. Without it, work for a
 * caller that already gave up runs to completion and is counted as wasted.
 *
 * The pricing admin routes play the pricing system: publishing a tariff or a
 * fuel surcharge emits TariffPublished / FuelSurchargeChanged to the
 * fq:ext:pricing stream.
 * @module deps/index
 */
import { randomUUID } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../shared/config.js'
import { createRedisConnection } from '../shared/cache.js'
import { logger } from '../shared/logger.js'
import { DEPENDENCIES, type Dependency } from '../shared/domain.js'
import { buildEnvelope, fuelStream, tariffStream, type NewEvent, type RawEnvelope } from '../shared/events.js'
import { xaddEvent } from '../shared/stream.js'
import { DEFAULT_KNOBS, knobSchema, planCall, Semaphore, type Knobs } from './knobs.js'
import { PricingWorld, type WorldState } from './world.js'

const redis = createRedisConnection('deps')
const world = new PricingWorld()
const STATE_KEY = 'fq:mock:pricing-state'
try {
  const saved = await redis.get(STATE_KEY)
  if (saved) world.load(JSON.parse(saved) as WorldState)
} catch (err) {
  logger.warn({ err: (err as Error).message }, 'could not load mock pricing state')
}
const saveWorld = () => redis.set(STATE_KEY, JSON.stringify(world.toState()))
const knobs: Record<Dependency, Knobs> = structuredClone(DEFAULT_KNOBS)
const pools = Object.fromEntries(DEPENDENCIES.map((d) => [d, new Semaphore(knobs[d].concurrency)])) as Record<Dependency, Semaphore>

interface DepStats {
  calls: number
  ok: number
  errors: number
  refused: number
  abandoned: number
  wasted: number
  wastedMs: number
  inflight: number
  maxInflight: number
}
const emptyStats = (): DepStats => ({ calls: 0, ok: 0, errors: 0, refused: 0, abandoned: 0, wasted: 0, wastedMs: 0, inflight: 0, maxInflight: 0 })
let stats = Object.fromEntries(DEPENDENCIES.map((d) => [d, emptyStats()])) as Record<Dependency, DepStats>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

async function simulate(dep: Dependency, req: Request, res: Response, answer: () => unknown | null): Promise<void> {
  const k = knobs[dep]
  const s = stats[dep]
  s.calls += 1
  if (k.down) {
    s.refused += 1
    res.status(503).json({ error: 'unavailable', dependency: dep })
    return
  }
  const header = req.get('x-deadline')
  const deadlineAt = header ? Number(header) : undefined
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
    s.abandoned += 1
    res.status(504).json({ error: 'deadline already passed on arrival', dependency: dep })
    return
  }
  let clientGone = false
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true
  })

  const release = await pools[dep].acquire(deadlineAt)
  if (!release) {
    s.abandoned += 1
    res.status(504).json({ error: 'deadline passed while queued', dependency: dep })
    return
  }
  s.inflight += 1
  s.maxInflight = Math.max(s.maxInflight, s.inflight)
  const started = Date.now()
  try {
    const plan = planCall(k)
    const workMs = plan.kind === 'hang' ? 30_000 : plan.workMs
    const finishAt = started + workMs
    await sleep((deadlineAt !== undefined ? Math.min(finishAt, deadlineAt) : finishAt) - Date.now())
    if (deadlineAt !== undefined && Date.now() >= deadlineAt && Date.now() < finishAt) {
      s.abandoned += 1
      if (!clientGone) res.status(504).json({ error: 'deadline exceeded; work abandoned', dependency: dep })
      return
    }
    if (clientGone) {
      // Nobody is waiting: the caller timed out without telling us its deadline.
      s.wasted += 1
      s.wastedMs += Date.now() - started
      return
    }
    if (plan.kind === 'hang') {
      res.status(504).json({ error: 'hung', dependency: dep })
      return
    }
    if (plan.kind === 'error') {
      s.errors += 1
      res.status(500).json({ error: 'injected failure', dependency: dep })
      return
    }
    const body = answer()
    if (body === null) {
      res.status(422).json({ error: 'unknown lane, commodity or contract', dependency: dep })
      return
    }
    s.ok += 1
    res.json(body)
  } finally {
    s.inflight -= 1
    release()
  }
}

const rateInput = z.object({
  customerId: z.string(),
  contractId: z.string().nullable(),
  origin: z.string(),
  destination: z.string(),
  commodity: z.string(),
  equipment: z.string(),
})
const laneInput = z.object({ origin: z.string(), destination: z.string(), commodity: z.string().optional(), equipment: z.string(), shipWeek: z.string(), quantity: z.number().int().positive() })

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'deps' })
})

app.post('/pricing/rate', (req, res) => {
  const input = rateInput.parse(req.body)
  void simulate('pricing', req, res, () => world.rate(input))
})

app.post('/fuel/surcharge', (req, res) => {
  const input = z.object({ origin: z.string(), destination: z.string() }).parse(req.body)
  void simulate('fuel', req, res, () => world.surcharge(input.origin, input.destination))
})

app.post('/capacity/check', (req, res) => {
  const input = laneInput.parse(req.body)
  void simulate('capacity', req, res, () => world.capacity(input.origin, input.destination, input.equipment, input.shipWeek))
})

app.post('/availability/check', (req, res) => {
  const input = laneInput.parse(req.body)
  void simulate('availability', req, res, () => world.availability(input.origin, input.equipment, input.shipWeek, input.quantity))
})

app.get('/knobs', (_req, res) => {
  res.json({ knobs, defaults: DEFAULT_KNOBS })
})

app.put('/knobs/:dep', (req, res) => {
  const dep = z.enum(['pricing', 'fuel', 'capacity', 'availability']).parse(req.params.dep)
  const next = knobSchema.parse({ ...knobs[dep], ...req.body })
  knobs[dep] = next
  pools[dep].limit = next.concurrency
  logger.info({ dep, knobs: next }, 'knobs changed')
  res.json({ knobs })
})

app.post('/knobs/reset', (_req, res) => {
  for (const d of DEPENDENCIES) {
    knobs[d] = structuredClone(DEFAULT_KNOBS[d])
    pools[d].limit = knobs[d].concurrency
  }
  res.json({ knobs })
})

app.get('/stats', (_req, res) => {
  const out = Object.fromEntries(DEPENDENCIES.map((d) => [d, { ...stats[d], queued: pools[d].queued }]))
  res.json({ stats: out })
})

app.post('/stats/reset', (_req, res) => {
  stats = Object.fromEntries(DEPENDENCIES.map((d) => [d, emptyStats()])) as Record<Dependency, DepStats>
  res.json({ ok: true })
})

// ─── The pricing system's publications ──────────────────────────────────
const published: RawEnvelope[] = []

async function emit(event: NewEvent): Promise<RawEnvelope> {
  await saveWorld()
  const env = buildEnvelope(event, 'pricing-system')
  env.stream_version = null
  await xaddEvent(redis, config.streams.external, { event: JSON.stringify(env), type: env.type })
  published.unshift(env)
  published.splice(50)
  return env
}

app.post('/admin/tariffs/publish', async (req, res, next) => {
  try {
    const input = z
      .object({ origin: z.string(), destination: z.string(), commodity: z.string(), equipment: z.string(), version: z.number().int().positive().optional() })
      .parse(req.body)
    const t = world.publishTariff(input.origin, input.destination, input.commodity, input.equipment, input.version)
    if (!t) {
      res.status(422).json({ error: 'unknown lane or commodity' })
      return
    }
    const env = await emit({
      type: 'TariffPublished',
      streamId: tariffStream(input.origin, input.destination, input.commodity, input.equipment),
      correlationId: `tariff-pub-${randomUUID().slice(0, 8)}`,
      payload: {
        tariff_id: t.tariffId,
        origin: input.origin,
        destination: input.destination,
        commodity: input.commodity,
        equipment: input.equipment,
        version: t.version,
        rate_per_car_cents: t.rate,
        effective_at: t.publishedAt,
      },
    })
    res.status(201).json({ event: env })
  } catch (err) {
    next(err)
  }
})

app.post('/admin/fuel/publish', async (req, res, next) => {
  try {
    const input = z.object({ centsPerMile: z.number().positive().max(500), effectiveDate: z.string().optional() }).parse(req.body)
    const previous = world.fuel.centsPerMile
    const effectiveDate = input.effectiveDate ?? world.fuel.effectiveDate
    const publishedAt = new Date().toISOString()
    if (effectiveDate >= world.fuel.effectiveDate) world.fuel = { effectiveDate, centsPerMile: input.centsPerMile, publishedAt }
    const env = await emit({
      type: 'FuelSurchargeChanged',
      streamId: fuelStream(),
      correlationId: `fsc-pub-${randomUUID().slice(0, 8)}`,
      payload: { effective_date: effectiveDate, published_at: publishedAt, cents_per_mile: input.centsPerMile, previous_cents_per_mile: previous },
    })
    res.status(201).json({ event: env })
  } catch (err) {
    next(err)
  }
})

app.get('/admin/events', (_req, res) => {
  res.json({ events: published })
})

/** Re-sends an already published event unchanged: a duplicate (and, if newer ones followed, late) delivery. */
app.post('/admin/events/:eventId/resend', async (req, res) => {
  const env = published.find((e) => e.event_id === req.params.eventId)
  if (!env) {
    res.status(404).json({ error: 'not found' })
    return
  }
  await xaddEvent(redis, config.streams.external, { event: JSON.stringify(env), type: env.type, resent: 'true' })
  res.json({ resent: env.event_id })
})

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid input', details: err.issues })
    return
  }
  logger.error({ err }, 'deps error')
  res.status(500).json({ error: 'internal' })
})

app.listen(config.depsPort, () => logger.info({ port: config.depsPort }, 'mock dependencies listening'))
