/**
 * ETA consumer entry point. Reads the car and train topics; health and metrics on ETA_PORT.
 */
process.env.SERVICE_NAME ??= 'eta'
const { runConsumer } = await import('../../shared/consumer.js')
const { config } = await import('../../shared/config.js')
const { ETA_TYPES, handleEta, emitClockTick } = await import('./handler.js')

await runConsumer({
  group: 'eta',
  topics: ['car', 'train'],
  types: ETA_TYPES,
  handle: handleEta,
  port: config.ports.eta,
  ticks: [{ name: 'clock', everyMs: 2_000, run: async () => void (await emitClockTick()) }],
})
