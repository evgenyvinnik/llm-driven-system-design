/**
 * Mock model service entry point (default port 3100).
 */
process.env.SERVICE_NAME ??= 'mock-model'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { createModelApp } = await import('./app.js')

const server = createModelApp().listen(config.modelPort, () => {
  logger.info({ port: config.modelPort }, 'mock model listening')
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
