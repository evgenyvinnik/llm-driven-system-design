/**
 * Highlight Service entry point
 * @module highlight/index
 */
import { app } from './app.js'
import { initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('highlight-service')
const PORT = process.env.HIGHLIGHT_PORT || 3001

async function start(): Promise<void> {
  await initRedis()

  app.listen(PORT, () => {
    logger.info({ event: 'server_started', port: PORT })
    console.log(`Highlight service running on port ${PORT}`)
  })
}

start().catch((err) => {
  logger.error({ event: 'startup_failed', error: err.message })
  process.exit(1)
})
