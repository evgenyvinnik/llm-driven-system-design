/**
 * Executor service: pulls generation IDs from the Valkey queue (consumer
 * group, so each entry reaches one executor), executes up to
 * EXECUTOR_CONCURRENCY generations at once, listens for cancel signals, and
 * runs the sweeper. Start more executors (dev:executor2) to scale out; they
 * coordinate only through PostgreSQL leases.
 */
process.env.SERVICE_NAME ??= 'executor'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { createRedisConnection, redis } = await import('../shared/cache.js')
const { metricsHandler, generationsInFlight } = await import('../shared/metrics.js')
const { GENERATION_CANCEL_CHANNEL, GENERATION_QUEUE_GROUP, GENERATION_QUEUE_STREAM } = await import(
  '../shared/generation-events.js'
)
const { abortGeneration, executeGeneration } = await import('./generation-executor.js')
const { sweepOnce } = await import('./sweeper.js')
const { default: express } = await import('express')
type InFlightGeneration = import('./generation-executor.js').InFlightGeneration

const executorId = config.executorId
const inFlight = new Map<string, InFlightGeneration>()
/** Generations this process has started, including ones still being claimed. Bounds concurrency. */
const active = new Set<string>()
const startedAt = new Date().toISOString()
let stopping = false
let wakeLoop: (() => void) | null = null

async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', GENERATION_QUEUE_STREAM, GENERATION_QUEUE_GROUP, '0', 'MKSTREAM')
  } catch (err) {
    if (!String((err as Error).message).includes('BUSYGROUP')) throw err
  }
}
await ensureGroup()

// Cancel signals: the API publishes a generation ID; only the executor running it acts.
const subscriber = createRedisConnection('cancel-subscriber')
await subscriber.subscribe(GENERATION_CANCEL_CHANNEL)
subscriber.on('message', (_channel: string, generationId: string) => {
  const entry = inFlight.get(generationId)
  if (entry) {
    logger.info({ generationId }, 'cancel requested')
    abortGeneration(entry, 'cancelled')
  }
})

function start(generationId: string) {
  active.add(generationId)
  generationsInFlight.set(active.size)
  executeGeneration(generationId, executorId, inFlight)
    .catch((err) => logger.error({ err, generationId }, 'executeGeneration rejected'))
    .finally(() => {
      active.delete(generationId)
      generationsInFlight.set(active.size)
      wakeLoop?.()
    })
}

async function pullLoop() {
  // Blocking reads need their own connection.
  const reader = createRedisConnection('queue-reader')
  while (!stopping) {
    const free = config.executorConcurrency - active.size
    if (free <= 0) {
      await new Promise<void>((resolve) => {
        wakeLoop = resolve
        setTimeout(resolve, 1000)
      })
      wakeLoop = null
      continue
    }
    try {
      // NOACK: the queue is a doorbell. If an executor dies after reading an
      // entry, the generation stays 'accepted' in PostgreSQL and the sweeper re-enqueues it.
      const result = (await reader.xreadgroup(
        'GROUP',
        GENERATION_QUEUE_GROUP,
        executorId,
        'COUNT',
        free,
        'BLOCK',
        2000,
        'NOACK',
        'STREAMS',
        GENERATION_QUEUE_STREAM,
        '>',
      )) as [string, [string, string[]][]][] | null
      for (const [, entries] of result ?? []) {
        for (const [, fields] of entries) {
          const generationId = fields[fields.indexOf('generationId') + 1]
          if (generationId && !active.has(generationId)) start(generationId)
        }
      }
    } catch (err) {
      if (stopping) break
      // A Valkey restart without persistence drops the consumer group; recreate it.
      // Generations enqueued meanwhile are still 'accepted' in PostgreSQL and the sweeper re-enqueues them.
      if (String((err as Error).message).includes('NOGROUP')) {
        logger.warn('queue consumer group missing; recreating')
        await ensureGroup().catch(() => undefined)
        continue
      }
      logger.warn({ err }, 'queue read failed; retrying')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  reader.disconnect()
}

async function announce() {
  const info = { id: executorId, inFlight: active.size, concurrency: config.executorConcurrency, startedAt, lastSeen: new Date().toISOString() }
  await redis.set(`executor:${executorId}`, JSON.stringify(info), 'EX', 15).catch(() => undefined)
}

const announceTimer = setInterval(() => void announce(), 5000)
await announce()
const sweepTimer = setInterval(() => {
  sweepOnce().catch((err) => logger.warn({ err }, 'sweep failed'))
}, config.sweepIntervalMs)

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', executorId, inFlight: active.size }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.executorPort, () => {
  logger.info({ executorId, port: config.executorPort, concurrency: config.executorConcurrency }, 'executor started')
})

const loop = pullLoop()

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal, inFlight: active.size }, 'executor draining')
  clearInterval(announceTimer)
  clearInterval(sweepTimer)
  // Give in-flight generations a few seconds to finish, then fail them explicitly
  // rather than leaving them for another executor's sweeper.
  const deadline = Date.now() + 8000
  while (active.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
  for (const entry of inFlight.values()) abortGeneration(entry, 'shutdown')
  while (active.size > 0 && Date.now() < deadline + 3000) await new Promise((r) => setTimeout(r, 100))
  await loop.catch(() => undefined)
  await redis.del(`executor:${executorId}`).catch(() => undefined)
  server.close()
  subscriber.disconnect()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
