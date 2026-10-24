/**
 * API entry point (default port 3000; dev:server1..3 use 3001-3003).
 * FS_STORE=memory runs without PostgreSQL and loads the demo data on start.
 */
import { seedDemo } from '../db/seed-data.js'
import { config } from '../shared/config.js'
import { createPool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import type { FsBackend } from '../store/backend.js'
import { MemoryBackend } from '../store/memory-backend.js'
import { PgBackend } from '../store/pg-backend.js'
import { createApp } from './app.js'

let backend: FsBackend
let ready: () => Promise<unknown>

if (config.store === 'memory') {
  backend = new MemoryBackend()
  await seedDemo(backend)
  ready = async () => {}
} else {
  const pool = createPool(config.databaseUrl)
  try {
    await pool.query('SELECT 1 FROM fs_nodes LIMIT 1')
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      'PostgreSQL is not reachable or not migrated. Run `docker-compose up -d && npm run db:migrate && npm run db:seed`, or `npm run dev:memory` to run without a database.',
    )
    process.exit(1)
  }
  backend = new PgBackend(pool)
  ready = () => pool.query('SELECT 1')
}

const server = createApp(backend, ready).listen(config.port, () => {
  logger.info({ port: config.port, store: backend.kind }, 'api listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()
  await backend.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
