/**
 * Outbox publisher process. Wakes on PostgreSQL NOTIFY (sent by the
 * transaction that wrote the outbox rows, delivered at commit) and also polls
 * every PUBLISHER_POLL_MS in case a notification was missed. Drains until a
 * batch comes back empty.
 */
import type { ConfirmChannel } from 'amqplib'

process.env.SERVICE_NAME ??= 'publisher'
const pg = (await import('pg')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { OUTBOX_CHANNEL } = await import('../shared/dispatch.js')
const { outboxLagSeconds } = await import('../shared/metrics.js')
const { superviseRabbit } = await import('../shared/queue.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { publishBatch } = await import('./relay.js')

let stopping = false
let wake: (() => void) | null = null
let pending = true
// Supervised connection: after a broker drop it reconnects and wakes the loop to drain the outbox.
const rabbit = superviseRabbit('publisher', { confirm: true }, async () => {
  pending = true
  wake?.()
})

const listener = new pg.Client({ connectionString: config.databaseUrl })
await listener.connect()
await listener.query(`LISTEN ${OUTBOX_CHANNEL}`)
listener.on('notification', () => {
  pending = true
  wake?.()
})
listener.on('error', (err) => logger.error({ err: err.message }, 'listen connection error'))

const http = startWorkerHttp(config.publisherPort, 'publisher', async () => {
  await pool.query('SELECT 1')
  if (!rabbit.current()) throw new Error('not connected to RabbitMQ')
})

async function updateLag() {
  const { rows } = await pool.query<{ age: number | null }>(
    `SELECT EXTRACT(EPOCH FROM now() - min(created_at))::float8 AS age FROM outbox WHERE published_at IS NULL`,
  )
  outboxLagSeconds.set(rows[0]?.age ?? 0)
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'publisher stopping')
  stopping = true
  wake?.()
  await rabbit.close()
  await listener.end().catch(() => undefined)
  http.close()
  await pool.end().catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

logger.info('outbox publisher running')
while (!stopping) {
  try {
    const handle = rabbit.current()
    if (handle) {
      pending = false
      let n = 0
      do {
        n = await publishBatch(handle.channel as ConfirmChannel)
      } while (n > 0 && !stopping)
    } else {
      await new Promise((r) => setTimeout(r, 500))
    }
    await updateLag()
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'publish pass failed; will retry')
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!pending && !stopping) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.publisher.pollMs)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    wake = null
  }
}
