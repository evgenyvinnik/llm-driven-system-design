/**
 * Retry scheduler: every SCHEDULER_TICK_MS moves due retries into the queue
 * (per-endpoint fair), reclaims expired leases, re-dispatches deliveries whose
 * ticket was lost, and prunes the outbox. Safe to run several copies.
 */
process.env.SERVICE_NAME ??= 'scheduler'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { dispatchDue, pruneOutbox, reclaimExpiredLeases, requeueStuck } = await import('./sweeps.js')

if (config.delivery.leaseMs < config.delivery.timeoutMs + 2000) {
  logger.warn({ leaseMs: config.delivery.leaseMs, timeoutMs: config.delivery.timeoutMs }, 'DELIVERY_LEASE_MS should exceed DELIVERY_TIMEOUT_MS by a margin')
}

const http = startWorkerHttp(config.schedulerPort, 'scheduler', async () => {
  await pool.query('SELECT 1')
})

let stopping = false
let tick = 0
logger.info({ tickMs: config.scheduler.tickMs, horizonSeconds: config.delivery.retryHorizonSeconds }, 'scheduler running')

async function shutdown(signal: string) {
  logger.info({ signal }, 'scheduler stopping')
  stopping = true
  http.close()
  await pool.end().catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

while (!stopping) {
  const started = Date.now()
  try {
    let n = 0
    do {
      n = await dispatchDue()
    } while (n >= config.scheduler.batchSize && !stopping)
    if (tick % 4 === 0) {
      const reclaimed = await reclaimExpiredLeases()
      if (reclaimed > 0) logger.warn({ reclaimed }, 'reclaimed deliveries from lost workers')
      const stuck = await requeueStuck()
      if (stuck > 0) logger.warn({ stuck }, 're-dispatched deliveries whose ticket was lost')
    }
    if (tick % 120 === 0) await pruneOutbox()
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'scheduler pass failed')
  }
  tick += 1
  await new Promise((r) => setTimeout(r, Math.max(10, config.scheduler.tickMs - (Date.now() - started))))
}
