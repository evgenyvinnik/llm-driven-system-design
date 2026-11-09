/**
 * The scheduler process: the sweeps nothing else would trigger. Lease expiry (a dead
 * runner sends no event), log archival and artifact retention. Readiness isn't here: it
 * is decided in the completion transaction. Safe to run twice, because every sweep is a
 * row-locked transaction that re-checks its condition.
 * @module scheduler/index
 */
process.env.SERVICE_NAME ??= 'scheduler'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { queueDepth } = await import('../shared/metrics.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { sweepExpiredLeases } = await import('../scheduling/engine.js')
const { archiveClosedStreams } = await import('../logs/archive.js')
const { expireArtifacts } = await import('./retention.js')

const server = startWorkerHttp(config.schedulerPort, 'scheduler', async () => {
  await pool.query('SELECT 1')
})

let stopping = false

function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let lastTick = Date.now()
  const loop = async () => {
    while (!stopping) {
      const late = Date.now() - lastTick - ms
      lastTick = Date.now()
      // The whole machine was asleep. Runners were frozen too, so every lease looks expired, unfairly.
      // Give them one interval to heartbeat before judging anybody.
      const stalled = name === 'leases' && late > config.lease.ms / 2
      if (stalled) logger.warn({ late }, 'this process stalled; skipping one lease sweep so runners can heartbeat first')
      else await fn().catch((err: Error) => logger.error({ err: err.message, code: (err as { code?: string }).code, name }, 'sweep failed'))
      await new Promise((resolve) => setTimeout(resolve, ms))
    }
  }
  void loop()
}

every('leases', config.scheduler.sweepMs, async () => {
  const results = await sweepExpiredLeases()
  for (const r of results) logger.info(r, 'lease expired')
})
every('archive', config.scheduler.archiveMs, () => archiveClosedStreams())
every('retention', config.scheduler.retentionMs, () => expireArtifacts())
every('queue-depth', 5000, async () => {
  const { rows } = await pool.query<{ label: string; queued: number }>(`SELECT label, count(*)::int AS queued FROM jobs, unnest(runs_on) AS label WHERE status = 'queued' GROUP BY label`)
  queueDepth.reset()
  for (const r of rows) queueDepth.set({ label: r.label }, r.queued)
})

logger.info({ sweepMs: config.scheduler.sweepMs, leaseMs: config.lease.ms }, 'scheduler started')

function shutdown(signal: string) {
  logger.info({ signal }, 'scheduler shutting down')
  stopping = true
  server.close()
  setTimeout(() => process.exit(0), 200)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
