/**
 * Planner process: re-plan request consumer, DTL order worker and ticket
 * reconciliation. Default port 3200 (health and metrics only).
 */
process.env.SERVICE_NAME ??= 'planner'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { PlannerWorker } = await import('./worker.js')
const { startOrderWorker } = await import('../orders/order-worker.js')
const { httpVendor } = await import('../orders/vendor-client.js')
const { reconcileTickets } = await import('../orders/reconcile.js')
const { expireReservations } = await import('./acceptance.js')

const planner = new PlannerWorker()
await planner.start()
const stopOrders = startOrderWorker(httpVendor)
const reconcileTimer = setInterval(() => {
  reconcileTickets().catch((err) => logger.error({ err }, 'reconcile failed'))
  expireReservations().catch((err) => logger.error({ err }, 'reservation expiry failed'))
}, 2000)
const server = startWorkerHttp(config.plannerPort, 'planner', async () => {
  await Promise.all([pool.query('SELECT 1'), redis.ping()])
})
logger.info('planner started')

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopOrders()
  clearInterval(reconcileTimer)
  await planner.stop()
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
