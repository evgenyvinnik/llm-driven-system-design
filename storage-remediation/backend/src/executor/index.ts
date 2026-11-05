/**
 * Executor worker (health and metrics on EXECUTOR_PORT, default 3300). Runs:
 * - EXECUTOR_CONCURRENCY worker slots reading the task stream (one blocking
 *   Valkey connection each) and applying targets
 * - the coordinator and reconciler (campaign/wave progression)
 * - the verifier (bake checks and automatic rollback)
 * - a periodic XAUTOCLAIM of messages a crashed executor left unacknowledged
 *
 * Any number of executors can run (dev:executor2); PostgreSQL claims with
 * leases and fences keep them from stepping on each other.
 */
process.env.SERVICE_NAME ??= 'executor'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis, createRedisConnection } = await import('../shared/cache.js')
const { metricsHandler } = await import('../shared/metrics.js')
const { HttpControlPlane } = await import('../arm/http-client.js')
const { RedisBuckets } = await import('./buckets.js')
const { PgTargetStore } = await import('./pg-store.js')
const { TaskQueue, publishEvent } = await import('./queue.js')
const { processTarget } = await import('./apply.js')
const { checkBakingTarget } = await import('./verify.js')
const { coordinate } = await import('./coordinator.js')
const { mapLimit } = await import('../scanner/deps.js')

const instanceId = process.env.INSTANCE_ID || `executor-${process.pid}`
const queue = new TaskQueue(redis, config.stream.tasks, config.stream.group)
await queue.ensureGroup()
const store = new PgTargetStore()
let writes = 0
let stopping = false

const deps = {
  store,
  arm: new HttpControlPlane(config.simUrl, 'remediation-executor'),
  buckets: new RedisBuckets(redis, { capacity: config.executor.bucketCapacity, refillPerSec: config.executor.bucketRefillPerSec }),
  events: (campaignId: string, event: Parameters<typeof publishEvent>[2]) => publishEvent(redis, config.stream.campaignEvents(campaignId), event),
  clock: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  instanceId,
  leaseMs: config.executor.leaseMs,
  maxAttempts: config.executor.maxAttempts,
  maxInlineWaitMs: 2000,
  baselineWindowMs: 60_000,
  thresholds: config.executor.rollback,
  afterWrite: () => {
    writes++
    if (config.executor.crashAfterWrites > 0 && writes >= config.executor.crashAfterWrites) {
      // Demo of the worst moment to die: the cloud has the change, PostgreSQL doesn't know yet.
      logger.error({ writes }, 'EXECUTOR_CRASH_AFTER_WRITES reached: exiting after a write, before recording it')
      process.exit(1)
    }
  },
}

async function handle(targetId: number): Promise<void> {
  try {
    const outcome = await processTarget(deps, targetId)
    if (outcome !== 'not_claimed') logger.debug({ targetId, outcome }, 'target processed')
  } catch (err) {
    // The claim's lease expires and the reconciler re-sends the target; recorded intent makes the retry safe.
    logger.warn({ err: err instanceof Error ? err.message : err, targetId }, 'target processing failed')
  }
}

const slots = Array.from({ length: config.executor.concurrency }, (_, i) => {
  const conn = createRedisConnection(`executor-slot-${i}`)
  const run = async () => {
    while (!stopping) {
      try {
        const messages = await queue.read(conn, instanceId, 2000)
        for (const m of messages) {
          await handle(m.targetId)
          await queue.ack(m.messageId)
        }
      } catch (err) {
        if (stopping) break
        // The stream (and its group) can be deleted by a reseed; recreate and carry on.
        if (String(err).includes('NOGROUP')) await queue.ensureGroup().catch(() => undefined)
        else logger.warn({ err: err instanceof Error ? err.message : err }, 'stream read failed')
        await deps.sleep(1000)
      }
    }
  }
  return { conn, done: run() }
})

const timers: NodeJS.Timeout[] = []
function loop(name: string, ms: number, fn: () => Promise<unknown>) {
  const tick = async () => {
    if (stopping) return
    try {
      await fn()
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, loop: name }, 'loop iteration failed')
    }
    if (!stopping) timers.push(setTimeout(tick, ms))
  }
  timers.push(setTimeout(tick, 0))
}

loop('coordinator', config.executor.coordinatorMs, () => coordinate({ queue, events: deps.events, instanceId, requeueAfterMs: config.executor.requeueAfterMs }))

loop('verifier', config.executor.verifierMs, async () => {
  const baking = await store.claimBaking(instanceId, 30_000, 40)
  if (baking.length === 0) return
  const campaigns = new Map<string, string>()
  await mapLimit(baking, 8, async (t) => {
    try {
      let controlId = campaigns.get(t.campaignId)
      if (!controlId) {
        controlId = (await store.campaign(t.campaignId))?.controlId
        if (controlId) campaigns.set(t.campaignId, controlId)
      }
      if (!controlId) return
      const outcome = await checkBakingTarget(deps, t, controlId)
      if (outcome !== 'baking') logger.info({ targetId: t.id, account: t.accountId, outcome }, 'bake check')
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, targetId: t.id }, 'bake check failed')
      await store.releaseBaking(t).catch(() => undefined)
    }
  })
})

loop('autoclaim', 30_000, async () => {
  const messages = await queue.autoclaim(instanceId, 60_000)
  for (const m of messages) {
    await handle(m.targetId)
    await queue.ack(m.messageId)
  }
})

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', instanceId, writes }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.executorPort, () => logger.info({ port: config.executorPort, instanceId, concurrency: config.executor.concurrency }, 'executor listening'))

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  timers.forEach(clearTimeout)
  server.close()
  // In-flight targets keep their lease until it expires; another executor resumes them.
  for (const s of slots) s.conn.disconnect()
  await Promise.allSettled([redis.quit(), pool.end()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
