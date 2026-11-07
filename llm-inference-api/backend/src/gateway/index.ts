/**
 * Gateway entry point (default port 3000; dev:server1 runs a second on 3001).
 */
process.env.SERVICE_NAME ??= 'gateway'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { hub } = await import('./stream-hub.js')
const { createApp } = await import('./app.js')

hub.start()
const server = createApp().listen(config.gatewayPort, () => {
  logger.info({ port: config.gatewayPort, instance: config.instanceId }, 'gateway listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  hub.stop()
  server.close()
  server.closeAllConnections?.()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
