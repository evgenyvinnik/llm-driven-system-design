/**
 * Mock DTL vendor entry point (default port 3300).
 */
process.env.SERVICE_NAME ??= 'vendor'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { createVendorApp } = await import('./app.js')

const { app } = createVendorApp()
const server = app.listen(config.vendorPort, () => logger.info({ port: config.vendorPort }, 'mock DTL vendor listening'))

function shutdown() {
  server.close()
  server.closeAllConnections?.()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
