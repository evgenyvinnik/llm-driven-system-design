/**
 * The analytics projector: consumer group `projector` over the event
 * partitions. Each event is applied in a transaction that first inserts
 * (projector, event_id) into processed_events, so a redelivered event is a
 * no-op. Exposes Prometheus metrics, including consumer lag and staleness.
 * @module projector/index
 */
import express from 'express'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { logger } from '../shared/logger.js'
import { StreamConsumer } from '../shared/consumer.js'
import { GROUPS } from '../shared/stream.js'
import { eventFromFields, startStreamMonitor } from '../shared/monitor.js'
import { eventsHandled, metricsHandler } from '../shared/metrics.js'
import { applyLive } from './analytics.js'

const consumer = new StreamConsumer({
  group: 'projector',
  consumer: config.projector.consumer,
  streams: GROUPS.projector(),
  batch: 50,
  handle: async (message) => {
    const event = eventFromFields(message.fields)
    const position = message.fields.position ? Number(message.fields.position) : null
    const applied = await withTransaction((client) => applyLive(client, event, position))
    eventsHandled.inc({ group: 'projector', type: event.type, result: applied ? 'applied' : 'duplicate' })
  },
})

await consumer.start()
const monitor = startStreamMonitor(redis, pool)

const app = express()
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'projector', consumer: config.projector.consumer })
})
app.get('/metrics', metricsHandler)
const server = app.listen(config.projectorPort, () => logger.info({ port: config.projectorPort }, 'projector metrics listening'))

async function shutdown(): Promise<void> {
  clearInterval(monitor)
  server.close()
  await consumer.stop()
  await pool.end()
  redis.disconnect()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
