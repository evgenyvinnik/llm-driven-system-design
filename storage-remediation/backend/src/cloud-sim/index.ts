/**
 * Cloud simulator entry point (default port 3100). Loads the fleet from the
 * state file written by `npm run db:seed`, or generates it from FLEET_SEED, and
 * writes changes back to the file so restarts keep applied changes.
 */
process.env.SERVICE_NAME ??= 'cloud-sim'
// Dynamic imports so SERVICE_NAME is set before the logger module initializes.
const { existsSync } = await import('node:fs')
const { resolve } = await import('node:path')
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { createSimApp } = await import('./app.js')
const { Fleet } = await import('./fleet.js')
const { generateFleet } = await import('./generate.js')

const stateFile = resolve(config.sim.stateFile)

function initialState() {
  if (existsSync(stateFile)) {
    try {
      return Fleet.load(stateFile)
    } catch (err) {
      logger.warn({ err, stateFile }, 'state file unreadable; regenerating')
    }
  }
  return generateFleet(config.sim.fleetSeed, config.sim.subscriptions, config.sim.accounts)
}

const fleet = new Fleet(initialState())
fleet.save(stateFile)

const app = createSimApp(fleet, {
  reload: () => fleet.replaceState(Fleet.load(stateFile)),
  reset: () => fleet.replaceState(generateFleet(config.sim.fleetSeed, config.sim.subscriptions, config.sim.accounts)),
})

const server = app.listen(config.simPort, () => {
  logger.info({ port: config.simPort, accounts: fleet.state.accounts.length, subscriptions: fleet.state.subscriptions.length, stateFile }, 'cloud simulator listening')
})

const persist = setInterval(() => {
  if (fleet.dirty) fleet.save(stateFile)
}, 1000)

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  clearInterval(persist)
  if (fleet.dirty) fleet.save(stateFile)
  server.close()
  server.closeAllConnections?.()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
