/**
 * Replanning process manager entry point. Reads the car and train topics; sweeps stuck sagas; health and
 * metrics on REPLANNER_PORT.
 */
process.env.SERVICE_NAME ??= 'replanner'
const { runConsumer } = await import('../shared/consumer.js')
const { config } = await import('../shared/config.js')
const { REPLANNER_TYPES, handleReplanner } = await import('./handler.js')
const { sweepSagas } = await import('./saga.js')

await runConsumer({
  group: 'replanner',
  topics: ['car', 'train'],
  types: REPLANNER_TYPES,
  handle: handleReplanner,
  port: config.ports.replanner,
  ticks: [{ name: 'saga-sweep', everyMs: config.replanner.sweepMs, run: sweepSagas }],
})
