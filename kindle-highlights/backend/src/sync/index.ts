/**
 * Sync Service entry point
 * @module sync/index
 */
import http from 'http'
import { app, createSyncServer } from './app.js'
import { initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('sync-service')
const PORT = process.env.SYNC_PORT || 3002

async function start(): Promise<void> {
  await initRedis()

  const server = http.createServer(app)
  const _wss = createSyncServer(server)

  server.listen(PORT, () => {
    logger.info({ event: 'server_started', port: PORT })
    console.log(`Sync service running on port ${PORT}`)
    console.log(`WebSocket available at ws://localhost:${PORT}/sync`)
  })
}

start().catch((err) => {
  logger.error({ event: 'startup_failed', error: err.message })
  process.exit(1)
})
