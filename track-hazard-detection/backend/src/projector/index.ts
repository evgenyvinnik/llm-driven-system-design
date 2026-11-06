/**
 * Projector service: maintains the read models (hazards, alerts, restrictions,
 * coverage, train positions) from the domain and trains topics, and publishes
 * live notices after each commit. Also exports projection staleness.
 */
process.env.SERVICE_NAME ??= 'projector'
const { config } = await import('../shared/config.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { StreamConsumer } = await import('../shared/consumer.js')
const { parsePartitions } = await import('../shared/streams.js')
const { onShutdown, startOpsServer } = await import('../shared/service.js')
const { publishLive } = await import('../shared/live.js')
const { projectionStaleness } = await import('../shared/metrics.js')
const { handleDomainEvent, handleTrainEvent } = await import('./handler.js')

let lastTrainNotice = 0
const consumer = new StreamConsumer({
  group: 'projector',
  consumer: process.env.PROJECTOR_CONSUMER || 'projector-1',
  partitions: parsePartitions(process.env.PROJECTOR_PARTITIONS),
  lanes: [
    { topic: 'domain', batch: 100 },
    { topic: 'trains', batch: 100 },
  ],
  handle: async (env, ctx) => {
    if (ctx.topic === 'trains') {
      const outcome = await handleTrainEvent(env)
      if (Date.now() - lastTrainNotice > 1000) {
        lastTrainNotice = Date.now()
        await publishLive([{ topics: ['trains'] }])
      }
      return outcome
    }
    const { outcome, notice } = await handleDomainEvent(env)
    if (notice) await publishLive([notice])
    return outcome
  },
})

const server = startOpsServer('projector', config.ports.projector)
await consumer.start()

const staleness = setInterval(() => {
  pool
    .query<{ projection: string; lag: number }>(
      `SELECT c.projection, GREATEST(0, EXTRACT(EPOCH FROM ((SELECT max(recorded_at) FROM events) - c.last_recorded_at)))::float AS lag FROM projection_checkpoints c`,
    )
    .then(({ rows }) => rows.forEach((r) => projectionStaleness.set({ projection: r.projection }, Number(r.lag) || 0)))
    .catch(() => undefined)
}, 5_000)

onShutdown(async () => {
  clearInterval(staleness)
  await consumer.stop()
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
})
