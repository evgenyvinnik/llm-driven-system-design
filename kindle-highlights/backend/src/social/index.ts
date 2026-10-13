/**
 * Social Service entry point
 * @module social/index
 */
import { app } from './app.js'
import { initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'
import { closeServer, onShutdown } from '../shared/lifecycle.js'

const logger = createLogger('social-service')
// 3001 is the port `npm run dev` exposes as PORT (the screenshot harness waits on it) and the
// Vite proxy's catch-all target for /api/auth, /api/users, /api/settings, ...
const PORT = process.env.SOCIAL_PORT || 3001

async function start(): Promise<void> {
  await initRedis()

  const server = app.listen(PORT, () => {
    logger.info({ event: 'server_started', port: PORT })
    console.log(`Social service running on port ${PORT}`)
  })

  onShutdown(logger, () => closeServer(server))
}

start().catch((err) => {
  logger.error({ event: 'startup_failed', error: err.message })
  process.exit(1)
})
