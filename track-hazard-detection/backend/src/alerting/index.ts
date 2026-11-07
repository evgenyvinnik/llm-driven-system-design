/**
 * Alerting service: the hazard-response process manager. Consumes the domain
 * topic and train positions, and fires durable ack-deadline timers (leader only).
 */
process.env.SERVICE_NAME ??= 'alerting'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { StreamConsumer } = await import('../shared/consumer.js')
const { parsePartitions } = await import('../shared/streams.js')
const { LeaderLock, onShutdown, startOpsServer } = await import('../shared/service.js')
const { handleDomainEvent, handleTrainEvent, fireDueTimers } = await import('./handler.js')

const consumerName = process.env.ALERTING_CONSUMER || 'alerting-1'
const consumer = new StreamConsumer({
  group: 'alerting',
  consumer: consumerName,
  partitions: parsePartitions(process.env.ALERTING_PARTITIONS),
  lanes: [
    { topic: 'domain', batch: 50 },
    { topic: 'trains', batch: 50 },
  ],
  handle: async (env, ctx) => {
    const result = ctx.topic === 'trains' ? await handleTrainEvent(env) : await handleDomainEvent(env)
    if (result.appended.length) logger.info({ hazard: env.streamId, appended: result.appended.map((e) => e.type) }, 'process manager appended')
    return result.outcome
  },
})

const server = startOpsServer('alerting', config.ports.alerting)
await consumer.start()

const leader = new LeaderLock(redis, 'th:lock:alerting-timers', consumerName, config.alerting.timerTickMs * 5)
const timerLoop = setInterval(() => {
  leader
    .tryAcquire()
    .then(async (isLeader) => {
      if (!isLeader) return
      const appended = await fireDueTimers()
      if (appended.length) logger.warn({ appended: appended.map((e) => `${e.type}:${e.streamId}`) }, 'ack deadline fired')
    })
    .catch((err) => logger.warn({ err: (err as Error).message }, 'timer sweep failed'))
}, config.alerting.timerTickMs)

onShutdown(async () => {
  clearInterval(timerLoop)
  await consumer.stop()
  await leader.release().catch(() => undefined)
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
})
