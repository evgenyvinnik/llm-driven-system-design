/**
 * API service entry point (default port 3000; dev:server1 adds 3001).
 * @module api/index
 */
process.env.SERVICE_NAME ??= `api-${process.env.PORT ?? 3000}`
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { ensureBucket } = await import('../shared/storage.js')
const { getPublisher } = await import('./services/publish.js')
const { createApp } = await import('./app.js')

getPublisher()
await ensureBucket().catch((err) => logger.warn({ err: (err as Error).message }, 'blob store not reachable yet; uploads will return 503 until it is'))

const server = createApp().listen(config.apiPort, () => {
  logger.info({ port: config.apiPort, instance: config.instanceId }, 'api listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()
  server.closeAllConnections?.()
  await Promise.allSettled([getPublisher().close(), pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
