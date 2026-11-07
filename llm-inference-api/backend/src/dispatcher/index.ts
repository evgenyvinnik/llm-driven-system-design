/**
 * Dispatcher entry point. Serves /health and /metrics on DISPATCHER_PORT
 * (3100). Run a second one with dev:dispatcher2 to see leader failover.
 */
process.env.SERVICE_NAME ??= 'dispatcher'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { metricsHandler } = await import('../shared/metrics.js')
const { Dispatcher } = await import('./loop.js')

const dispatcher = new Dispatcher()
await dispatcher.start()

const app = express()
app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    instance: config.instanceId,
    leader: dispatcher.isLeader,
    flights: dispatcher.executor.flights.size,
    backends: [...dispatcher.registry.states.values()].map((s) => ({ id: s.id, reachable: s.reachable, status: s.health?.status ?? 'unknown', inflight: s.inflight })),
  }),
)
app.get('/metrics', metricsHandler)
const server = app.listen(config.dispatcherPort, () => logger.info({ port: config.dispatcherPort, instance: config.instanceId }, 'dispatcher listening'))
server.on('error', (err: NodeJS.ErrnoException) => {
  // A second dispatcher on the same port still dispatches; it just has no metrics endpoint.
  if (err.code === 'EADDRINUSE') logger.warn({ port: config.dispatcherPort }, 'metrics port in use; running without /metrics')
  else throw err
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  await dispatcher.stop()
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
