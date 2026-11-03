/**
 * Export worker entry point. Polls PostgreSQL for runnable export jobs; run
 * several (dev:worker2) and SKIP LOCKED keeps them from taking the same job.
 */
process.env.SERVICE_NAME ??= 'worker'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { claimJob, failAbandonedJobs, runExport } = await import('./export-runner.js')

let stopping = false

async function loop(): Promise<void> {
  logger.info({ workerId: config.workerId }, 'export worker started')
  let lastSweep = 0
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > config.exportLeaseSeconds * 1000) {
        await failAbandonedJobs()
        lastSweep = Date.now()
      }
      const job = await claimJob(config.workerId)
      if (job) {
        await runExport(job, config.workerId)
        continue
      }
    } catch (err) {
      logger.error({ err }, 'worker loop error')
    }
    await new Promise((resolve) => setTimeout(resolve, config.workerPollMs))
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down')
  stopping = true
  // An export in progress keeps its lease until it expires; another worker resumes it from the start.
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await loop()
