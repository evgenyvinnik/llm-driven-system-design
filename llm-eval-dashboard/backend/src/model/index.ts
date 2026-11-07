/**
 * Mock model entry point (default port 3100, MODEL_PORT).
 */
process.env.SERVICE_NAME ??= 'mock-model'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { createModelApp } = await import('./app.js')

const { app } = createModelApp()
const server = app.listen(config.modelPort, () => logger.info({ port: config.modelPort }, 'mock model listening'))

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()
  server.closeAllConnections?.()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
