/**
 * Mock model backend entry point. Run three of them (BACKEND_ID b1..b3,
 * BACKEND_PORT 3101..3103). The iteration loop drives the engine.
 */
process.env.SERVICE_NAME ??= `backend-${process.env.BACKEND_ID || 'b1'}`
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { Engine } = await import('./engine.js')
const { createBackendApp } = await import('./app.js')

const cfg = config.backend
const engine = new Engine({
  model: cfg.model,
  version: cfg.version,
  slots: cfg.slots,
  ttftMs: cfg.ttftMs,
  prefillMsPerToken: cfg.prefillMsPerToken,
  tokensPerSecond: cfg.tokensPerSecond,
  admitOverheadMs: cfg.admitOverheadMs,
  cacheEntries: cfg.cacheEntries,
  batching: cfg.batching,
  restartMs: cfg.restartMs,
  crashAfterTokens: cfg.crashAfterTokens,
  slowExtraMs: cfg.slowExtraMs,
})

let stopped = false
async function loop() {
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, engine.nextPeriod()))
    try {
      engine.step(Date.now())
    } catch (err) {
      logger.error({ err }, 'engine step failed')
    }
  }
}
void loop()

const server = createBackendApp(engine, cfg.id).listen(cfg.port, () => {
  logger.info({ port: cfg.port, id: cfg.id, version: cfg.version, slots: cfg.slots, batching: cfg.batching }, 'mock backend listening')
})

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopped = true
  engine.stop()
  server.close()
  server.closeAllConnections?.()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
