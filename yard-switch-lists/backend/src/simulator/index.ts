/**
 * Simulator process: control HTTP API plus the tick loop. It starts paused, so
 * the seeded yard stays put until someone presses start. The API proxies these
 * routes to the browser with a role check, so this port itself has no auth and
 * is for local use only.
 */
process.env.SERVICE_NAME ??= 'simulator'
const express = (await import('express')).default
const { randomUUID } = await import('node:crypto')
const { z } = await import('zod')
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool, withTransaction } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { errorHandler, asyncHandler, HttpError } = await import('../shared/errors.js')
const { metricsHandler } = await import('../shared/metrics.js')
const { MIN } = await import('../domain/params.js')
const { makeHoldEvent } = await import('../holds/apply.js')
const { publishHoldEvent } = await import('../holds/stream.js')
const { resetYard } = await import('../plans/yard-load.js')
const { httpPort } = await import('./port.js')
const { YardSimulator, chooseHoldCar } = await import('./engine.js')

const port = httpPort()
const sim = new YardSimulator(port, { seed: config.simulator.seed, exceptionRate: 0.02, autoRoll: true })
let running = false
let speed = config.simulator.speed
let busy = false
let lastError: string | null = null
const holds: Record<string, { holdId: string; caseId: string; streamVersion: number }> = {}

async function attach() {
  try {
    await sim.attach()
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'simulator could not attach yet (is the API up?)')
  }
}
await attach()

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  while (busy) await new Promise((resolve) => setTimeout(resolve, 20))
  busy = true
  try {
    return await fn()
  } finally {
    busy = false
  }
}

setInterval(() => {
  if (!running || busy) return
  void exclusive(() => sim.tick(speed * config.simulator.tickMs)).catch((err) => {
    lastError = err instanceof Error ? err.message : String(err)
    logger.warn({ err: lastError }, 'tick failed')
  })
}, config.simulator.tickMs)

const app = express()
app.use(express.json())

function stateDto() {
  return {
    seed: sim.seed,
    running,
    speed,
    now: sim.now ? new Date(sim.now).toISOString() : null,
    exceptionRate: sim.exceptionRate,
    autoRoll: sim.autoRoll,
    crews: sim.crewState,
    delayedReports: sim.delayedReports,
    dropNext: sim.dropNext,
    eventCount: sim.log.length,
    digest: sim.digest(),
    scenarioDigest: sim.scenarioDigest(),
    recent: sim.log.slice(-25).reverse(),
    lastError,
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', running }))
app.get('/metrics', metricsHandler)
app.get('/control/state', (_req, res) => res.json(stateDto()))

app.post(
  '/control/start',
  asyncHandler(async (req, res) => {
    const body = z.object({ speed: z.number().int().min(1).max(3600).optional() }).parse(req.body ?? {})
    if (body.speed) speed = body.speed
    await exclusive(() => sim.attach())
    running = true
    res.json(stateDto())
  }),
)

app.post('/control/pause', (_req, res) => {
  running = false
  res.json(stateDto())
})

app.post(
  '/control/step',
  asyncHandler(async (req, res) => {
    const body = z.object({ minutes: z.number().min(1).max(1440), stepMin: z.number().min(0.5).max(30).default(1), settle: z.boolean().default(true) }).parse(req.body ?? {})
    running = false
    await exclusive(async () => {
      if (!sim.now) await sim.attach()
      await sim.step(body.minutes, body.stepMin, body.settle)
    })
    res.json(stateDto())
  }),
)

app.post(
  '/control/settings',
  asyncHandler(async (req, res) => {
    const body = z.object({ exceptionRate: z.number().min(0).max(1).optional(), speed: z.number().int().min(1).max(3600).optional(), autoRoll: z.boolean().optional(), autoPublish: z.boolean().optional() }).parse(req.body ?? {})
    if (body.exceptionRate !== undefined) sim.exceptionRate = body.exceptionRate
    if (body.speed !== undefined) speed = body.speed
    if (body.autoRoll !== undefined) sim.autoRoll = body.autoRoll
    if (body.autoPublish !== undefined) await pool.query(`UPDATE yard_state SET auto_publish = $1`, [body.autoPublish])
    res.json(stateDto())
  }),
)

/** Starts over from the seed, on the database directly. This is a dev harness, not an operations path. */
app.post(
  '/control/reset',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        seed: z.number().int().optional(),
        exceptionRate: z.number().min(0).max(1).optional(),
        deterministic: z.boolean().optional(),
        iterations: z.number().int().min(1).optional(),
        timeLimitMs: z.number().int().min(10).optional(),
        autoPublish: z.boolean().optional(),
      })
      .parse(req.body ?? {})
    running = false
    await exclusive(async () => {
      const seed = body.seed ?? sim.seed
      // Deterministic mode: an iteration limit decides when a solve ends, not the clock.
      const settings = body.deterministic ? { iterations: body.iterations ?? 400, timeLimitMs: 120_000, deterministic: true } : { ...(body.iterations ? { iterations: body.iterations } : {}), ...(body.timeLimitMs ? { timeLimitMs: body.timeLimitMs } : {}) }
      await withTransaction((client) => resetYard(client, { seed, plannerSettings: settings, autoPublish: body.autoPublish ?? true }))
      await redis.del(`${config.keyPrefix}${config.holds.stream}`).catch(() => undefined)
      sim.reset(seed, body.exceptionRate ?? 0)
      for (const k of Object.keys(holds)) delete holds[k]
      await port.settle()
    })
    res.json(stateDto())
  }),
)

app.post(
  '/control/next-shift',
  asyncHandler(async (_req, res) => {
    const out = await exclusive(() => port.nextShift())
    res.json(out)
  }),
)

// ── Scenarios ───────────────────────────────────────────────────────────

app.post(
  '/scenario/late-train',
  asyncHandler(async (req, res) => {
    const body = z.object({ inboundId: z.string().optional(), minutes: z.number().int().min(1).max(1440).default(180) }).parse(req.body ?? {})
    const out = await exclusive(async () => sim.lateTrain(await port.view(), body.inboundId, body.minutes))
    res.json(out)
  }),
)

app.post(
  '/scenario/block-track',
  asyncHandler(async (req, res) => {
    const body = z.object({ trackId: z.string().default('C4'), reopenAfterMin: z.number().int().min(1).nullable().optional(), reason: z.string().optional() }).parse(req.body ?? {})
    res.json(await exclusive(() => sim.blockTrack(body.trackId, body.reopenAfterMin ?? null, body.reason)))
  }),
)

app.post(
  '/scenario/unblock-track',
  asyncHandler(async (req, res) => {
    const body = z.object({ trackId: z.string() }).parse(req.body ?? {})
    res.json(await exclusive(() => port.trackStatus(body.trackId, true, 'cleared')))
  }),
)

app.post(
  '/scenario/drop-report',
  asyncHandler(async (req, res) => {
    const body = z.object({ count: z.number().int().min(1).max(20).default(1) }).parse(req.body ?? {})
    sim.dropReports(body.count)
    res.json(stateDto())
  }),
)

/** Produces the same event #19 would, onto the same stream. Nothing in the yard is told any other way. */
app.post(
  '/scenario/hold',
  asyncHandler(async (req, res) => {
    const body = z.object({ carId: z.string().optional(), reason: z.string().optional() }).parse(req.body ?? {})
    const view = await port.view()
    const carId = chooseHoldCar(view, body.carId)
    const caseId = randomUUID()
    const holdId = `hold-${caseId.slice(0, 8)}`
    holds[carId] = { holdId, caseId, streamVersion: 1 }
    const event = makeHoldEvent({ eventId: randomUUID(), type: 'CarHoldPlaced', holdId, carId, caseId, streamVersion: 1, occurredAt: new Date(sim.now).toISOString(), reason: body.reason })
    await publishHoldEvent(redis, event)
    sim.record(`scenario hold ${carId}`)
    res.json({ carId, holdId, eventId: event.event_id })
  }),
)

app.post(
  '/scenario/release',
  asyncHandler(async (req, res) => {
    const body = z.object({ carId: z.string() }).parse(req.body)
    const known = holds[body.carId]
    if (!known) throw new HttpError(404, 'HOLD_NOT_FOUND', `The simulator didn't place a hold on ${body.carId}`)
    known.streamVersion++
    const event = makeHoldEvent({ eventId: randomUUID(), type: 'CarHoldReleased', holdId: known.holdId, carId: body.carId, caseId: known.caseId, streamVersion: known.streamVersion, occurredAt: new Date(sim.now + MIN).toISOString() })
    await publishHoldEvent(redis, event)
    sim.record(`scenario release ${body.carId}`)
    res.json({ carId: body.carId, holdId: known.holdId, eventId: event.event_id })
  }),
)

app.use(errorHandler)
const server = app.listen(config.simulatorPort, () => logger.info({ port: config.simulatorPort, seed: sim.seed }, 'simulator listening, paused'))
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error({ port: config.simulatorPort }, 'simulator port in use')
    process.exit(1)
  }
  throw err
})
if (config.simulator.autostart) running = true

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  running = false
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
