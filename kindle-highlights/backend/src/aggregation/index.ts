/**
 * Aggregation Service entry point
 * @module aggregation/index
 */
import { app } from './app.js'
import { initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('aggregation-service')
const PORT = process.env.AGGREGATION_PORT || 3003

async function start(): Promise<void> {
  await initRedis()

  app.listen(PORT, () => {
    logger.info({ event: 'server_started', port: PORT })
    console.log(`Aggregation service running on port ${PORT}`)
  })
}

start().catch((err) => {
  logger.error({ event: 'startup_failed', error: err.message })
  process.exit(1)
})
