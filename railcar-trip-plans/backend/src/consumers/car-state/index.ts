/**
 * car-state consumer entry point. Reads the car and train topics; health and metrics on CAR_STATE_PORT.
 */
process.env.SERVICE_NAME ??= 'car-state'
const { runConsumer } = await import('../../shared/consumer.js')
const { config } = await import('../../shared/config.js')
const { CAR_STATE_TYPES, handleCarState } = await import('./handler.js')

await runConsumer({ group: 'car-state', topics: ['car', 'train'], types: CAR_STATE_TYPES, handle: handleCarState, port: config.ports.carState })
