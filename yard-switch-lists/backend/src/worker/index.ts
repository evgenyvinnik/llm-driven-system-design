/**
 * Planner worker. Runs apart from the API because a search is CPU-bound: here a
 * long solve only slows this process, and the search yields so the lease
 * heartbeat keeps running. Inside:
 *   - the coalescer, which turns replan triggers into one solve
 *   - the plan lane, one solve at a time
 *   - the analysis lane, comparisons and replays, which can't delay a plan
 *   - the hold-feed consumer
 * Kill it at any point: a claimed job's lease runs out and the next worker takes
 * it, and a plan only exists once its single final transaction commits.
 */
process.env.SERVICE_NAME ??= 'worker'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { createRedisConnection, redis } = await import('../shared/cache.js')
const { metricsHandler, solveLeaseReclaims } = await import('../shared/metrics.js')
const { claimJob, failJob, heartbeat } = await import('./jobs.js')
const { coalesceTriggers } = await import('./coalescer.js')
const { runPlanJob } = await import('./run-plan.js')
const { finishAnalysisJob, runComparison, runReplayJob } = await import('./run-analysis.js')
const { startHoldConsumer } = await import('../holds/stream.js')
const { raiseAlert } = await import('../plans/state.js')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let running = true
const active: Record<string, string | null> = { plan: null, analysis: null }

async function runOne(lane: 'plan' | 'analysis'): Promise<boolean> {
  const job = await claimJob(lane, config.instanceId)
  if (!job) return false
  active[lane] = job.id
  if (job.reclaimed) {
    solveLeaseReclaims.inc()
    logger.warn({ job: job.id, attempts: job.attempts }, 'reclaimed a solve from a lost worker')
  }
  logger.info({ job: job.id, purpose: job.purpose, algorithm: job.algorithm, attempt: job.attempts, reason: job.reason }, 'solve started')
  let lost = false
  const beat = setInterval(() => {
    heartbeat(job.id, job.leaseToken)
      .then((ok) => {
        if (!ok) lost = true
      })
      .catch((err) => logger.warn({ err: err.message }, 'heartbeat failed'))
  }, config.planner.heartbeatMs)
  try {
    if (lane === 'plan') {
      const outcome = await runPlanJob(job, () => lost)
      logger.info({ job: job.id, ...outcome }, 'solve finished')
    } else {
      const stats = job.purpose === 'compare' ? await runComparison(job) : await runReplayJob(job)
      await finishAnalysisJob(job, stats)
      logger.info({ job: job.id, purpose: job.purpose }, 'analysis finished')
    }
  } catch (err) {
    logger.error({ err, job: job.id }, 'solve failed')
    const result = await failJob(job.id, job.leaseToken, job.attempts, err instanceof Error ? err.message : String(err))
    if (result === 'failed') {
      await raiseAlert(pool, { dedupKey: `planner:failed:${job.id}`, kind: 'planner_failed', severity: 'critical', message: `A ${job.purpose} solve failed ${job.attempts} times. Crews keep working from the last published plan. Last error: ${err instanceof Error ? err.message : err}` })
    }
  } finally {
    clearInterval(beat)
    active[lane] = null
  }
  return true
}

async function laneLoop(lane: 'plan' | 'analysis') {
  while (running) {
    try {
      const worked = await runOne(lane)
      if (!worked) await sleep(config.planner.pollMs)
    } catch (err) {
      logger.warn({ err, lane }, 'worker lane error')
      await sleep(1000)
    }
  }
}

async function coalesceLoop() {
  while (running) {
    try {
      await coalesceTriggers()
    } catch (err) {
      logger.warn({ err }, 'coalescer error')
    }
    await sleep(config.planner.pollMs)
  }
}

const blocking = createRedisConnection('hold-consumer')
const consumer = startHoldConsumer(blocking, config.instanceId)
void coalesceLoop()
void laneLoop('plan')
void laneLoop('analysis')

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', instance: config.instanceId, active }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.workerPort, () => logger.info({ port: config.workerPort, instance: config.instanceId }, 'worker listening'))
// A second worker on the same machine still works; it just has no metrics port.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') logger.warn({ port: config.workerPort }, 'metrics port in use; running without it')
  else throw err
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  running = false
  consumer.stop()
  server.close()
  blocking.disconnect()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
