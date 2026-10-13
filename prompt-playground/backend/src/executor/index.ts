/**
 * Executor service: pulls run IDs from the Valkey queue (consumer group, so
 * each entry reaches one executor), executes up to EXECUTOR_CONCURRENCY runs
 * at once, listens for cancel signals, and runs the sweeper. Start more
 * executors (dev:executor2) to scale out; they coordinate only through
 * PostgreSQL leases.
 */
process.env.SERVICE_NAME ??= 'executor'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { createRedisConnection, redis } = await import('../shared/cache.js')
const { metricsHandler, runsInFlight } = await import('../shared/metrics.js')
const { RUN_CANCEL_CHANNEL, RUN_QUEUE_GROUP, RUN_QUEUE_STREAM } = await import('../shared/run-events.js')
const { abortRun, executeRun } = await import('./run-executor.js')
const { sweepOnce } = await import('./sweeper.js')
const { default: express } = await import('express')
type InFlightRun = import('./run-executor.js').InFlightRun

const executorId = config.executorId
const inFlight = new Map<string, InFlightRun>()
/** Runs this process has started, including ones still being claimed. Bounds concurrency. */
const active = new Set<string>()
const startedAt = new Date().toISOString()
let stopping = false
let wakeLoop: (() => void) | null = null

try {
  await redis.xgroup('CREATE', RUN_QUEUE_STREAM, RUN_QUEUE_GROUP, '0', 'MKSTREAM')
} catch (err) {
  if (!String((err as Error).message).includes('BUSYGROUP')) throw err
}

// Cancel signals: the API publishes a run ID; only the executor running it acts.
const subscriber = createRedisConnection('cancel-subscriber')
await subscriber.subscribe(RUN_CANCEL_CHANNEL)
subscriber.on('message', (_channel: string, runId: string) => {
  const entry = inFlight.get(runId)
  if (entry) {
    logger.info({ runId }, 'cancel requested')
    abortRun(entry, 'cancelled')
  }
})

function start(runId: string) {
  active.add(runId)
  runsInFlight.set(active.size)
  executeRun(runId, executorId, inFlight)
    .catch((err) => logger.error({ err, runId }, 'executeRun rejected'))
    .finally(() => {
      active.delete(runId)
      runsInFlight.set(active.size)
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
      // entry, the run stays 'queued' in PostgreSQL and the sweeper re-enqueues it.
      const result = (await reader.xreadgroup(
        'GROUP',
        RUN_QUEUE_GROUP,
        executorId,
        'COUNT',
        free,
        'BLOCK',
        2000,
        'NOACK',
        'STREAMS',
        RUN_QUEUE_STREAM,
        '>',
      )) as [string, [string, string[]][]][] | null
      for (const [, entries] of result ?? []) {
        for (const [, fields] of entries) {
          const runId = fields[fields.indexOf('runId') + 1]
          if (runId && !active.has(runId)) start(runId)
        }
      }
    } catch (err) {
      if (stopping) break
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
  // Give in-flight runs a few seconds to finish, then fail them explicitly
  // rather than leaving them for another executor's sweeper.
  const deadline = Date.now() + 8000
  while (active.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
  for (const entry of inFlight.values()) abortRun(entry, 'shutdown')
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
