/**
 * Mock judge entry point (default port 3105, JUDGE_PORT).
 */
process.env.SERVICE_NAME ??= 'mock-judge'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { createJudgeApp } = await import('./app.js')

const { app } = createJudgeApp()
const server = app.listen(config.judgePort, () => logger.info({ port: config.judgePort }, 'mock judge listening'))

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()
  server.closeAllConnections?.()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
