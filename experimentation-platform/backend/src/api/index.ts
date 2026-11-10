/**
 * API entry point (default port 3000; `npm run dev` also starts a second
 * instance on 3001 so cross-instance push is always exercised).
 */
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { createApp } = await import('./app.js')
const { startLive, stopLive } = await import('./live.js')
const { startSnapshotSync, stopSnapshotSync, reconcileOnce } = await import('../services/snapshot-service.js')

startLive()
startSnapshotSync()
await reconcileOnce().catch((err) => logger.warn({ err: (err as Error).message }, 'initial snapshot load failed; will retry'))

const server = createApp().listen(config.port, () => {
  logger.info({ port: config.port }, 'experimentation api listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopLive()
  stopSnapshotSync()
  server.close()
  server.closeAllConnections?.()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
