/**
 * Eval worker: claims generation and score tasks from PostgreSQL and runs up
 * to WORKER_CONCURRENCY of them at once. Run any number of copies; they
 * coordinate only through row locks and leases.
 *
 *   WORKER_ID, WORKER_PORT (health + metrics), WORKER_CONCURRENCY, LEASE_MS
 */
process.env.SERVICE_NAME ??= 'worker'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { claimDuration, workerInFlight } = await import('../shared/metrics.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { claimGenerationTask } = await import('./tasks.js')
const { claimScoreTask } = await import('./score-tasks.js')
const { executeGeneration, executeScore, InflightRegistry } = await import('./execute.js')
const { superviseListener } = await import('./listener.js')
const { cancelledAmong, sweepOnce } = await import('./sweeper.js')

const workerId = config.instanceId
const inflight = new InflightRegistry()
let active = 0
let stopping = false
let wake: (() => void) | null = null
let preferScores = false

const http = startWorkerHttp(config.workerPort, 'worker', async () => {
  await pool.query('SELECT 1')
})

function poke() {
  wake?.()
}

function cancelRun(runId: string) {
  const n = inflight.abortRun(runId, 'cancelled')
  if (n > 0) logger.info({ run: runId, aborted: n }, 'run cancelled; aborted in-flight calls')
}

const listener = superviseListener({ onTasks: poke, onCancel: cancelRun })

async function claimOne(): Promise<boolean> {
  preferScores = !preferScores
  const order = preferScores ? (['score', 'generation'] as const) : (['generation', 'score'] as const)
  for (const kind of order) {
    const end = claimDuration.startTimer({ kind })
    if (kind === 'score') {
      const task = await claimScoreTask(pool, workerId, config.worker.leaseMs)
      end({ result: task ? 'claimed' : 'empty' })
      if (task) {
        start(() => executeScore(task, inflight))
        return true
      }
    } else {
      const client = await pool.connect()
      try {
        const task = await claimGenerationTask(client, workerId, config.worker.leaseMs)
        end({ result: task ? 'claimed' : 'empty' })
        if (task) {
          start(() => executeGeneration(task, inflight))
          return true
        }
      } finally {
        client.release()
      }
    }
  }
  return false
}

function start(fn: () => Promise<void>) {
  active++
  workerInFlight.set(active)
  fn()
    .catch((err) => logger.error({ err }, 'task execution failed (its lease will expire and another worker retries it)'))
    .finally(() => {
      active--
      workerInFlight.set(active)
      poke()
    })
}

async function loop() {
  while (!stopping) {
    let claimed = false
    try {
      while (!stopping && active < config.worker.concurrency && (await claimOne())) claimed = true
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'claim failed')
    }
    if (claimed && active < config.worker.concurrency) continue
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.worker.idlePollMs)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    wake = null
  }
}

const sweepTimer = setInterval(() => {
  sweepOnce().catch((err) => logger.warn({ err: err.message }, 'sweep failed'))
}, config.worker.sweepMs)

// Fallback for a missed NOTIFY: re-check runs we have calls in flight for.
const cancelPoll = setInterval(() => {
  cancelledAmong(inflight.runIds())
    .then((ids) => ids.forEach(cancelRun))
    .catch(() => undefined)
}, 1000)

async function shutdown(signal: string) {
  logger.info({ signal, active }, 'shutting down; in-flight tasks will be re-claimed after their leases expire')
  stopping = true
  poke()
  clearInterval(sweepTimer)
  clearInterval(cancelPoll)
  http.close()
  await listener.stop()
  await pool.end().catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

logger.info({ workerId, concurrency: config.worker.concurrency, leaseMs: config.worker.leaseMs }, 'worker started')
await loop()
