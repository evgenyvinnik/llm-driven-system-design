/**
 * Analyzer worker entry point. Consumes the pass stream, keeps per-bearing
 * trend state (derived from PostgreSQL), scores risk, manages alerts, holds and
 * work orders, and runs the detector-health check. Run several with different
 * ANALYZER_CONSUMER names (dev:worker1/2): the consumer group splits the stream
 * and the per-trip advisory lock keeps one writer per trip.
 */
process.env.SERVICE_NAME ??= 'analyzer'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis, createRedisConnection } = await import('../shared/cache.js')
const { startClockSync } = await import('../shared/clock.js')
const { metricsHandler } = await import('../shared/metrics.js')
const { runConsumer } = await import('./consumer.js')
const { startHealthJob } = await import('./health-job.js')

let stopping = false
const streamClient = createRedisConnection('analyzer-stream')
const stopClock = startClockSync(redis)
const stopHealth = startHealthJob()

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', consumer: config.stream.consumer }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.analyzerMetricsPort, () => logger.info({ port: config.analyzerMetricsPort, consumer: config.stream.consumer }, 'analyzer started'))

const loop = runConsumer(streamClient, () => stopping)

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  stopHealth()
  stopClock()
  server.close()
  // Let the in-flight message finish; unacked messages are reclaimed by another consumer.
  await Promise.race([loop, new Promise((r) => setTimeout(r, 3000))])
  streamClient.disconnect()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
