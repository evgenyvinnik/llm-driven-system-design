/**
 * Mock receiver process (default port 3300). Stands in for customers'
 * servers; every seeded endpoint points at one of its /hooks/* paths.
 */
process.env.SERVICE_NAME ??= 'receiver'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { createReceiverApp, defaultReceiverOptions, platformSecrets } = await import('./app.js')
const { ReceiverState } = await import('./state.js')

const state = new ReceiverState()
const app = createReceiverApp(state, platformSecrets(config.apiUrl, config.internalToken), defaultReceiverOptions)
const server = app.listen(config.receiverPort, () => logger.info({ port: config.receiverPort, apiUrl: config.apiUrl }, 'mock receiver listening'))

function shutdown(signal: string) {
  logger.info({ signal }, 'receiver stopping')
  server.close()
  server.closeAllConnections?.()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
