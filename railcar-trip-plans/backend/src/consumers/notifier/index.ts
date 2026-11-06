/**
 * Notifier consumer entry point. Reads the car topic; flushes digests on a tick; health and metrics on
 * NOTIFIER_PORT.
 */
process.env.SERVICE_NAME ??= 'notifier'
const { runConsumer } = await import('../../shared/consumer.js')
const { config } = await import('../../shared/config.js')
const { NOTIFIER_TYPES, handleNotifier, flushDigests } = await import('./handler.js')

await runConsumer({
  group: 'notifier',
  topics: ['car'],
  types: NOTIFIER_TYPES,
  handle: handleNotifier,
  port: config.ports.notifier,
  ticks: [{ name: 'digest-flush', everyMs: config.notifier.tickMs, run: async () => void (await flushDigests()) }],
})
