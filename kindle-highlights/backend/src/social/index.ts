/**
 * Social Service entry point
 * @module social/index
 */
import { app } from './app.js'
import { initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('social-service')
const PORT = process.env.SOCIAL_PORT || 3004

async function start(): Promise<void> {
  await initRedis()

  app.listen(PORT, () => {
    logger.info({ event: 'server_started', port: PORT })
    console.log(`Social service running on port ${PORT}`)
  })
}

start().catch((err) => {
  logger.error({ event: 'startup_failed', error: err.message })
  process.exit(1)
})
