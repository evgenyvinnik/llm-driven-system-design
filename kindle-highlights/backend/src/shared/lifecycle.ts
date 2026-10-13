/**
 * Graceful shutdown for service entry points
 * @module shared/lifecycle
 */
import type http from 'http'
import type { Logger } from 'pino'
import { pool } from './db.js'
import { redis } from './cache.js'

/**
 * On SIGTERM/SIGINT: run the service-specific cleanup (stop accepting work, finish in-flight
 * work), then close the shared Redis client and PostgreSQL pool, then exit.
 */
export function onShutdown(logger: Logger, cleanup: () => Promise<void> = async () => {}): void {
  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info({ event: 'shutdown_started', signal })
    try {
      await cleanup()
      if (redis.isOpen) await redis.quit()
      await pool.end()
      logger.info({ event: 'shutdown_completed' })
      process.exit(0)
    } catch (error) {
      logger.error({ event: 'shutdown_failed', error: (error as Error).message })
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

/** Stops an HTTP server from accepting connections and waits for in-flight requests. */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections()
  })
}
