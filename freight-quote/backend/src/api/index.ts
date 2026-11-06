/**
 * Quote API entry point: HTTP, per-dependency breakers, the outbox relay
 * (one leader across instances) and the ops snapshot publisher.
 * Run several on different ports (dev:server1, dev:server2) to see the relay
 * leader lock and per-instance breakers and shedding.
 * @module api/index
 */
import { config } from '../shared/config.js'
import { redis, createRedisConnection } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { ComponentCache } from '../shared/component-cache.js'
import { DependencyBreakers } from '../shared/breakers.js'
import { HedgeBudget, SingleFlight } from '../shared/resilience.js'
import { recordCircuitTransition } from '../shared/circuit-events.js'
import { OutboxRelay } from '../shared/relay.js'
import { DEPENDENCIES, type Dependency } from '../shared/domain.js'
import { DEFAULT_SETTINGS } from '../shared/settings.js'
import { OpsStats } from './services/ops-stats.js'
import { QuoteService } from './services/quotes.js'
import { createApp } from './app.js'

const breakers = new DependencyBreakers('api', (dep, state, openMs) => recordCircuitTransition(dep, state, openMs, config.instanceId, 'quote-api'))
const stats = new OpsStats(() => breakers.states())
const fanout = {
  cache: new ComponentCache(redis),
  breakers,
  singleFlight: new SingleFlight(),
  hedgeBudgets: Object.fromEntries(DEPENDENCIES.map((d) => [d, new HedgeBudget(DEFAULT_SETTINGS.hedging.budgetPct)])) as Record<Dependency, HedgeBudget>,
  observer: stats,
}
const quotes = new QuoteService(redis, fanout, stats)
const app = createApp({ redis, quotes, stats })

const relay = new OutboxRelay(redis)
relay.start()

const snapshotTimer = setInterval(() => {
  stats.publish(redis).catch(() => undefined)
}, config.ops.snapshotMs)

// "Reset stats" on the ops page resets every instance.
const subscriber = createRedisConnection('api-ops-sub')
void subscriber.subscribe('fq:ops:reset')
subscriber.on('message', () => stats.reset())

const server = app.listen(config.apiPort, () => logger.info({ port: config.apiPort, instance: config.instanceId }, 'quote API listening'))
server.keepAliveTimeout = 65_000

async function shutdown(): Promise<void> {
  clearInterval(snapshotTimer)
  server.close()
  await relay.stop()
  breakers.shutdown()
  subscriber.disconnect()
  await pool.end()
  redis.disconnect()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
