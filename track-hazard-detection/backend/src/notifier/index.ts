/**
 * Notifier service (simulated channels). Consumes the domain topic.
 */
process.env.SERVICE_NAME ??= 'notifier'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { StreamConsumer } = await import('../shared/consumer.js')
const { parsePartitions } = await import('../shared/streams.js')
const { onShutdown, startOpsServer } = await import('../shared/service.js')
const { handleDomainEvent, sweepStuck } = await import('./notifier.js')

const consumer = new StreamConsumer({
  group: 'notifier',
  consumer: process.env.NOTIFIER_CONSUMER || 'notifier-1',
  partitions: parsePartitions(process.env.NOTIFIER_PARTITIONS),
  lanes: [{ topic: 'domain', batch: 50 }],
  handle: (env) => handleDomainEvent(env),
})

const server = startOpsServer('notifier', config.ports.notifier)
await consumer.start()
const sweeper = setInterval(() => {
  sweepStuck()
    .then((n) => n > 0 && logger.warn({ retried: n }, 'retried stuck notifications'))
    .catch((err) => logger.warn({ err: (err as Error).message }, 'notification sweep failed'))
}, 5_000)

onShutdown(async () => {
  clearInterval(sweeper)
  await consumer.stop()
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
})
