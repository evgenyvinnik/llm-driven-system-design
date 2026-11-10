/**
 * Fixture Git host entry point (default port 3105).
 */
process.env.SERVICE_NAME ??= 'githost'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { createHostApp } = await import('./app.js')
const { startWebhookSender } = await import('./webhooks.js')

const urls = (process.env.WEBHOOK_URLS || `${config.apiUrl}/webhooks/git-host`).split(',').map((u) => u.trim())
const stopSender = startWebhookSender(urls)
const server = createHostApp(urls).listen(config.gitHostPort, () => {
  logger.info({ port: config.gitHostPort, webhookUrls: urls }, 'git host listening')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopSender()
  server.close()
  server.closeAllConnections?.()
  await pool.end().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
