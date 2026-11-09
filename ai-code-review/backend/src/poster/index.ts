/**
 * Poster entry point. This is the one process holding the host write credential.
 */
import pg from 'pg'

process.env.SERVICE_NAME ??= 'poster'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { httpHostReader } = await import('../shared/host-client.js')
const { startOpsServer } = await import('../shared/worker-http.js')
const { claimNextIntent, processIntent } = await import('./post.js')
const { httpHostWriter } = await import('./host-writer.js')

const deps = { reader: httpHostReader, writer: httpHostWriter, actor: 'poster' }
let stopping = false
let wake: (() => void) | null = null

async function loop(): Promise<void> {
  while (!stopping) {
    const intent = await claimNextIntent(config.instanceId).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'claim failed')
      return null
    })
    if (intent) {
      await processIntent(deps, intent).catch((err) => logger.error({ intent: intent.id, err }, 'intent crashed; its lease will expire'))
      continue
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.poster.idlePollMs)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }
}

const listener = new pg.Client({ connectionString: config.databaseUrl })
listener.on('error', (err) => logger.warn({ err: err.message }, 'listener error'))
await listener.connect().catch((err) => logger.warn({ err: (err as Error).message }, 'LISTEN unavailable; relying on polling'))
await listener.query('LISTEN post_intent_queued').catch(() => undefined)
listener.on('notification', () => wake?.())

const ops = startOpsServer(config.posterPort, 'poster')
const running = [loop(), loop()]
logger.info({ instance: config.instanceId }, 'poster started')

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  wake?.()
  await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, 2000))])
  ops.close()
  await listener.end().catch(() => undefined)
  await pool.end().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
