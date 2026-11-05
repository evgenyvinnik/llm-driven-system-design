/**
 * Processor entry point. PROCESSOR_PARTITIONS picks which partition streams
 * this instance owns (default: all), the same way a Kafka consumer is assigned
 * partitions. Two instances with disjoint partitions split the fleet.
 */
process.env.SERVICE_NAME ??= 'processor'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { ProcessorWorker } = await import('./worker.js')

const all = Array.from({ length: config.telemetry.partitions }, (_, i) => i)
const partitions = config.processor.partitions.length ? config.processor.partitions : all
const worker = new ProcessorWorker(partitions)
await worker.start()
const server = startWorkerHttp(config.processorPort, 'processor', async () => {
  await Promise.all([pool.query('SELECT 1'), redis.ping()])
})
logger.info({ partitions }, 'processor started')

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  await worker.stop()
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
