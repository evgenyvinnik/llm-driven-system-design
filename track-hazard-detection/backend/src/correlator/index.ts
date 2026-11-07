/**
 * Correlator service: consumes edge.critical (first), trains, then edge.bulk,
 * runs complex event processing into hazard events, and ticks watermarks.
 * Partition ownership is static (CORRELATOR_PARTITIONS, default all).
 */
process.env.SERVICE_NAME ??= 'correlator'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { StreamConsumer } = await import('../shared/consumer.js')
const { parsePartitions } = await import('../shared/streams.js')
const { LeaderLock, onShutdown, startOpsServer } = await import('../shared/service.js')
const { publishLive } = await import('../shared/live.js')
const { handleEdgeEvent } = await import('./handler.js')
const { tick } = await import('./tick.js')

const consumerName = process.env.CORRELATOR_CONSUMER || 'correlator-1'
const consumer = new StreamConsumer({
  group: 'correlator',
  consumer: consumerName,
  partitions: parsePartitions(process.env.CORRELATOR_PARTITIONS),
  lanes: [
    { topic: 'edge.critical', batch: config.streams.criticalBatch },
    { topic: 'trains', batch: 50 },
    { topic: 'edge.bulk', batch: config.streams.bulkBatch },
  ],
  handle: async (env) => {
    const result = await handleEdgeEvent(env)
    if (result.appended.some((e) => e.type.startsWith('Coverage'))) await publishLive([{ topics: ['coverage'] }])
    return result.outcome
  },
})

const server = startOpsServer('correlator', config.ports.correlator)
await consumer.start()

const leader = new LeaderLock(redis, 'th:lock:correlator-tick', consumerName, config.correlation.tickMs * 3)
const ticker = setInterval(() => {
  leader
    .tryAcquire()
    .then((isLeader) => (isLeader ? tick() : undefined))
    .catch((err) => logger.warn({ err: (err as Error).message }, 'correlator tick failed'))
}, config.correlation.tickMs)

onShutdown(async () => {
  clearInterval(ticker)
  await consumer.stop()
  await leader.release().catch(() => undefined)
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
})
