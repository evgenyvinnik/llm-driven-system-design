/**
 * API service entry point (default port 3000; dev:server1/2 use 3001/3002).
 */
process.env.SERVICE_NAME ??= 'api'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { createApp } = await import('./app.js')
const { startSweeper } = await import('../orchestrator/sweeper.js')

const server = createApp().listen(config.apiPort, () => {
  logger.info({ port: config.apiPort, instance: config.instanceId, model: config.model.provider }, 'api listening')
})
const stopSweeper = startSweeper()

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopSweeper()
  // Running turns keep their lease until it expires; another instance's sweeper resumes them.
  server.close()
  server.closeAllConnections?.()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
