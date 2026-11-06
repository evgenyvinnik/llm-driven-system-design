/**
 * Exceptions consumer entry point. Reads the car topic; runs the event-time dwell sweep; health and metrics
 * on EXCEPTIONS_PORT.
 */
process.env.SERVICE_NAME ??= 'exceptions'
const { runConsumer } = await import('../../shared/consumer.js')
const { config } = await import('../../shared/config.js')
const { EXCEPTION_TYPES, handleException, sweepDwell } = await import('./handler.js')

await runConsumer({
  group: 'exceptions',
  topics: ['car'],
  types: EXCEPTION_TYPES,
  handle: handleException,
  port: config.ports.exceptions,
  ticks: [{ name: 'dwell-sweep', everyMs: config.exceptions.sweepMs, run: async () => void (await sweepDwell()) }],
})
