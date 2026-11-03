/**
 * API service entry point (default port 3000; dev:server1..3 use 3001-3003).
 */
process.env.SERVICE_NAME ??= 'api'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { eventHub } = await import('./services/event-hub.js')
const { createApp } = await import('./app.js')

const server = createApp().listen(config.apiPort, () => {
  logger.info({ port: config.apiPort }, 'api listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  // Open streams end; browsers reconnect (to another instance) and get a fresh hello.
  server.close()
  await eventHub.shutdown()
  server.closeAllConnections?.()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
