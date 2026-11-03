/**
 * Indexer process (default port 3200 for /health and /metrics).
 */
process.env.SERVICE_NAME ??= 'indexer'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { metricsHandler, registry } = await import('../shared/metrics.js')
const { processBatch, indexStatus } = await import('./worker.js')
const express = (await import('express')).default
const client = (await import('prom-client')).default

const indexed = new client.Counter({ name: 'indexer_events_total', help: 'Index events processed', registers: [registry] })
const lag = new client.Gauge({
  name: 'indexer_oldest_pending_seconds',
  help: 'Age of the oldest unprocessed event per lane',
  labelNames: ['lane'],
  registers: [registry],
})

let stopping = false
async function loop() {
  while (!stopping) {
    try {
      const outcome = await processBatch()
      indexed.inc(outcome.events)
      if (outcome.events > 0) logger.info(outcome, 'indexed batch')
      else await new Promise((resolve) => setTimeout(resolve, config.index.pollMs))
    } catch (err) {
      logger.error({ err }, 'indexer loop error')
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

setInterval(() => {
  indexStatus()
    .then((status) => status.pending.forEach((p) => lag.set({ lane: p.lane }, p.oldestSeconds ?? 0)))
    .catch(() => undefined)
}, 5000).unref()

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.indexerPort, () => logger.info({ port: config.indexerPort }, 'indexer listening'))
void loop()

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  await pool.end().catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
