/**
 * API service entry point (default port 3000; dev:server1/2 use 3001/3002).
 * Stateless: commands append to the event store in their transaction; the relay
 * (in the workers process) publishes. Nothing here writes to the broker.
 */
process.env.SERVICE_NAME ??= 'api'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { startClockSync } = await import('../shared/clock.js')
const { createApp } = await import('./app.js')
const { closeLive } = await import('./services/live.js')

const stopClock = startClockSync(redis)
const server = createApp().listen(config.apiPort, () => {
  logger.info({ port: config.apiPort, instance: config.instanceId }, 'api listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopClock()
  await closeLive()
  server.close()
  server.closeAllConnections?.()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
