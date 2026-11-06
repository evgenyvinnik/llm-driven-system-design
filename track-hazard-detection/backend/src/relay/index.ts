/**
 * Outbox relay service. Only the leader publishes; a standby takes over within
 * the lock TTL if the leader dies.
 */
process.env.SERVICE_NAME ??= 'relay'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { LeaderLock, onShutdown, startOpsServer } = await import('../shared/service.js')
const { listenForOutbox, pruneOutbox, relayPass, updateBacklogGauge } = await import('./relay.js')

const server = startOpsServer('relay', config.ports.relay)
const leader = new LeaderLock(redis, 'th:lock:relay', config.instanceId, config.relay.leaderTtlMs)
let running = true
let wake: (() => void) | null = null
const listener = await listenForOutbox(() => wake?.())

async function loop(): Promise<void> {
  let isLeader = false
  let lastLeaderCheck = 0
  while (running) {
    try {
      if (Date.now() - lastLeaderCheck > config.relay.leaderTtlMs / 3) {
        const was: boolean = isLeader
        isLeader = await leader.tryAcquire()
        lastLeaderCheck = Date.now()
        if (isLeader !== was) logger.info({ leader: isLeader }, isLeader ? 'relay is leader' : 'relay is standby')
      }
      if (isLeader) await relayPass(redis)
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'relay pass failed')
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.relay.pollMs)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
    wake = null
  }
}

const gauges = setInterval(() => void updateBacklogGauge().catch(() => undefined), 2_000)
const prune = setInterval(() => void pruneOutbox().catch(() => undefined), 60_000)
const done = loop()

onShutdown(async () => {
  running = false
  wake?.()
  clearInterval(gauges)
  clearInterval(prune)
  await done
  await leader.release().catch(() => undefined)
  await listener.end().catch(() => undefined)
  server.close()
  await Promise.allSettled([pool.end(), redis.quit()])
})
