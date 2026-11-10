/**
 * API entry point (default port 3000; `npm run dev` also starts a second
 * instance on 3001 so cross-instance SSE fan-out is always exercised).
 */
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { createApp } = await import('./app.js')
const { startSubscriber, stopLive } = await import('./live.js')

startSubscriber()
const server = createApp().listen(config.port, () => {
  logger.info({ port: config.port, chaos: config.chaosEnabled }, 'settings api listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopLive()
  server.close()
  server.closeAllConnections?.()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
