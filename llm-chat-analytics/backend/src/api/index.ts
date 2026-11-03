import { redis } from '../shared/cache.js'
import { clickhouse } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { createApp } from './app.js'

const server = createApp().listen(config.apiPort, () => logger.info({ port: config.apiPort }, 'api listening'))

const shutdown = () => {
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit(), clickhouse.close()])
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
