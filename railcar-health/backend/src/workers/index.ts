/**
 * Workers entry point (default metrics port 3011). Runs, in one process:
 *   relay             event store -> broker streams (one active instance; others stand by)
 *   projections       alert-queue, car-history, detector-health, reliability
 *   notifier          NotificationRequested -> provider -> NotificationDelivered
 *   workorder-sync    yard maintenance integration
 *   ack-process       the acknowledgment process manager + its durable-timer poller
 * WORKER_ROLES=relay,projections,notifier,workorders,process limits what runs, so any piece can be
 * killed and restarted on its own (`npm run dev:relay`, `npm run dev:projections`, ...).
 */
process.env.SERVICE_NAME ??= 'workers'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis, createRedisConnection } = await import('../shared/cache.js')
const { nowMs, startClockSync } = await import('../shared/clock.js')
const { consumerLag, dlqDepthGauge, eventsPerSecond, metricsHandler, projectionStaleness, relayLag } = await import('../shared/metrics.js')
const { runConsumerGroup } = await import('../events/consumer.js')
const { startRelay } = await import('../events/relay.js')
const { opsOverview } = await import('../events/ops.js')
const { groupSpec, projectionSpecs } = await import('../events/topology.js')
const { projectionHandler } = await import('./projector.js')
const { notifierHandler } = await import('./notifier.js')
const { workOrderSyncHandler } = await import('./workorder-sync.js')
const { ackProcessHandler, startTimerPoller } = await import('./ack-process.js')

const roles = new Set((process.env.WORKER_ROLES || 'relay,projections,notifier,workorders,process').split(',').map((r) => r.trim()))
let stopping = false
const stops: Array<() => unknown> = []
const loops: Array<Promise<void>> = []
const connections: Array<ReturnType<typeof createRedisConnection>> = []
stops.push(startClockSync(redis))

function consume(group: string, handler: Parameters<typeof runConsumerGroup>[0]['handler']) {
  const conn = createRedisConnection(`workers-${group}`)
  connections.push(conn)
  loops.push(runConsumerGroup({ spec: groupSpec(group)!, handler, redis: conn, shouldStop: () => stopping }).catch((err) => logger.error({ group, err: err.message }, 'consumer stopped')))
}

if (roles.has('relay')) {
  const conn = createRedisConnection('workers-relay')
  connections.push(conn)
  const stopRelay = startRelay(conn)
  stops.push(stopRelay)
}
if (roles.has('projections')) for (const p of projectionSpecs()) consume(p.group, projectionHandler(p.group))
if (roles.has('notifier')) consume('notifier', notifierHandler)
if (roles.has('workorders')) consume('workorder-sync', workOrderSyncHandler)
if (roles.has('process')) {
  consume('ack-process', ackProcessHandler)
  stops.push(startTimerPoller())
}

// Sample the pipeline into Prometheus gauges.
const sampler = setInterval(() => {
  opsOverview(redis, pool, nowMs())
    .then((o) => {
      relayLag.set(o.relay.lag)
      dlqDepthGauge.set(o.dlq.depth)
      eventsPerSecond.set(o.eventsPerSecond.last10s)
      for (const g of o.groups) {
        projectionStaleness.set({ group: g.group }, g.stalenessSeconds)
        for (const s of g.streams) consumerLag.set({ group: g.group, stream: s.family }, (s.lag ?? 0) + s.pending)
      }
    })
    .catch((err) => logger.debug({ err: (err as Error).message }, 'ops sample failed'))
}, 5000)

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', roles: [...roles] }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.workersPort, () => logger.info({ port: config.workersPort, roles: [...roles] }, 'workers started'))

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  clearInterval(sampler)
  server.close()
  await Promise.allSettled(stops.map((s) => s()))
  await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))])
  for (const c of connections) c.disconnect()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
