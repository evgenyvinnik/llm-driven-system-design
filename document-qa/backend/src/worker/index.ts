/**
 * Pipeline worker. Consumes `docqa.pipeline` tickets (prefetch =
 * WORKER_CONCURRENCY), runs one stage per ticket, and runs the sweeper.
 * Health and metrics on WORKER_PORT (a second copy on the same port keeps
 * working without /metrics).
 * @module worker/index
 */
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { decodeTicket, superviseRabbit, TicketPublisher } from '../shared/queue.js'
import { ensureBucket } from '../shared/storage.js'
import { startWorkerHttp } from '../shared/worker-http.js'
import { runTicket } from './run-ticket.js'
import { startSweeper } from './sweeper.js'

const workerId = config.instanceId
const publisher = new TicketPublisher(`${workerId}-pub`)
let inFlight = 0

await ensureBucket().catch((err) => logger.warn({ err: (err as Error).message }, 'blob store not reachable yet; stages will retry'))

const consumer = superviseRabbit(workerId, config.pipeline.concurrency, async (h) => {
  await h.channel.consume(config.queue.pipeline, (msg) => {
    if (!msg) return
    const ticket = decodeTicket(msg.content)
    if (!ticket) {
      h.channel.ack(msg)
      return
    }
    inFlight += 1
    runTicket(ticket.jobId, msg.fields.redelivered, workerId, publisher)
      .then((result) => logger.debug({ jobId: ticket.jobId, result }, 'ticket handled'))
      .catch((err) => logger.error({ err: (err as Error).message, jobId: ticket.jobId }, 'ticket handling crashed; job lease will expire and be retried'))
      .finally(() => {
        inFlight -= 1
        try {
          h.channel.ack(msg)
        } catch {
          // Channel already closed: the broker requeues the message and the claim sorts out the duplicate.
        }
      })
  })
})

const stopSweeper = startSweeper(publisher)

const server = startWorkerHttp(config.workerPort, workerId, async () => {
  await pool.query('SELECT 1')
  if (!consumer.current()) throw new Error('rabbitmq not connected')
})

logger.info({ workerId, concurrency: config.pipeline.concurrency }, 'pipeline worker started')

async function shutdown(): Promise<void> {
  stopSweeper()
  await consumer.close()
  const deadline = Date.now() + 5000
  while (inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  await publisher.close()
  server.close()
  await pool.end().catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
