/**
 * The async worker process:
 *  - group `completer`: QuoteRequested → firm quote (retries, DLQ, redrive);
 *  - group `webhooks`: FirmQuoteCompleted → signed callback delivery rows, plus the dispatcher loop;
 *  - group `invalidator`: TariffPublished / FuelSurchargeChanged → cache invalidation and re-pricing;
 *  - the expiry sweeper, and Prometheus metrics with consumer lag and DLQ depth.
 * Run several (dev:worker1, dev:worker2): consumer groups share the work, and
 * a dead worker's pending messages are claimed by the others.
 * @module completer/index
 */
import express from 'express'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { logger } from '../shared/logger.js'
import { StreamConsumer, sleep } from '../shared/consumer.js'
import { GROUPS } from '../shared/stream.js'
import { eventFromFields, startStreamMonitor } from '../shared/monitor.js'
import { eventsHandled, metricsHandler } from '../shared/metrics.js'
import { ComponentCache } from '../shared/component-cache.js'
import { DependencyBreakers } from '../shared/breakers.js'
import { HedgeBudget, SingleFlight } from '../shared/resilience.js'
import { recordCircuitTransition } from '../shared/circuit-events.js'
import { noopObserver, type FanoutContext } from '../shared/fanout.js'
import { DEPENDENCIES, type Dependency } from '../shared/domain.js'
import { completeFirmQuote } from './firm.js'
import { handleFuelSurchargeChanged, handleTariffPublished } from './invalidator.js'
import { expireDueQuotes } from './expiry.js'
import { dispatchDue, enqueueFirmCallback } from './webhooks.js'

const cache = new ComponentCache(redis)
const breakers = new DependencyBreakers('completer', (dep, state, openMs) => recordCircuitTransition(dep, state, openMs, config.completer.consumer, 'firm-completer'))
const fanout: FanoutContext = {
  cache,
  breakers,
  singleFlight: new SingleFlight(),
  hedgeBudgets: Object.fromEntries(DEPENDENCIES.map((d) => [d, new HedgeBudget(0)])) as Record<Dependency, HedgeBudget>,
  observer: noopObserver,
}

let crashArmed = config.completer.crashBeforeAckOnce

const completer = new StreamConsumer({
  group: 'completer',
  consumer: config.completer.consumer,
  streams: GROUPS.completer(),
  types: ['QuoteRequested'],
  concurrency: 8,
  handle: async (message) => {
    const event = eventFromFields(message.fields)
    if (event.type !== 'QuoteRequested') return
    const result = await completeFirmQuote(event, message.deliveries, redis, fanout)
    eventsHandled.inc({ group: 'completer', type: event.type, result })
    const level = result === 'complete' || message.deliveries > 1 ? 'info' : 'debug'
    logger[level]({ quote: event.payload.quote_id, result, deliveries: message.deliveries }, 'QuoteRequested handled')
  },
  beforeAck: (message) => {
    if (crashArmed && message.fields.type === 'QuoteRequested') {
      crashArmed = false
      logger.error({ id: message.id }, 'CRASH_BEFORE_ACK_ONCE: exiting after commit, before XACK')
      process.exit(1)
    }
  },
})

const webhooks = new StreamConsumer({
  group: 'webhooks',
  consumer: config.completer.consumer,
  streams: GROUPS.webhooks(),
  types: ['FirmQuoteCompleted'],
  handle: async (message) => {
    const event = eventFromFields(message.fields)
    if (event.type !== 'FirmQuoteCompleted') return
    const result = await enqueueFirmCallback(event)
    eventsHandled.inc({ group: 'webhooks', type: event.type, result })
  },
})

const invalidator = new StreamConsumer({
  group: 'invalidator',
  consumer: config.completer.consumer,
  streams: GROUPS.invalidator(),
  types: ['TariffPublished', 'FuelSurchargeChanged'],
  handle: async (message) => {
    const event = eventFromFields(message.fields)
    let result
    if (event.type === 'TariffPublished') result = await handleTariffPublished(event, cache)
    else if (event.type === 'FuelSurchargeChanged') result = await handleFuelSurchargeChanged(event, cache)
    else return
    eventsHandled.inc({ group: 'invalidator', type: event.type, result: result.outcome })
    logger.info({ type: event.type, eventId: event.event_id, ...result }, 'pricing event handled')
  },
})

await completer.start()
await webhooks.start()
await invalidator.start()
const monitor = startStreamMonitor(redis, pool)

let running = true
async function loop(name: string, intervalMs: number, fn: () => Promise<number>): Promise<void> {
  while (running) {
    try {
      const n = await fn()
      if (n > 0) logger.debug({ loop: name, n }, 'loop tick')
    } catch (err) {
      logger.warn({ loop: name, err: (err as Error).message }, 'loop error')
    }
    await sleep(intervalMs)
  }
}
void loop('expiry', config.completer.expirySweepMs, () => expireDueQuotes())
void loop('webhook-dispatch', config.webhooks.pollMs, () => dispatchDue())

const app = express()
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'completer', consumer: config.completer.consumer, breakers: breakers.states() })
})
app.get('/metrics', metricsHandler)
const server = app.listen(config.completerPort, () => logger.info({ port: config.completerPort, consumer: config.completer.consumer }, 'completer listening'))

async function shutdown(): Promise<void> {
  running = false
  clearInterval(monitor)
  server.close()
  breakers.shutdown()
  await Promise.all([completer.stop(), webhooks.stop(), invalidator.stop()])
  await pool.end()
  redis.disconnect()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
