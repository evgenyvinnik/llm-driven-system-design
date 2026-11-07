/**
 * Delivery worker: consumes tickets from the `deliveries` quorum queue with
 * prefetch = WORKER_CONCURRENCY and handles them concurrently. A ticket is
 * acked only after its outcome is committed to PostgreSQL, so a worker that
 * dies mid-attempt leaves the ticket unacked and RabbitMQ hands it to another
 * worker. Run several (dev:worker1, dev:worker2); they share nothing but the
 * queue, PostgreSQL and the Valkey semaphores. The broker connection is
 * supervised: if it drops, the worker reconnects and consumes again.
 */
import type { Channel, ConsumeMessage } from 'amqplib'

process.env.SERVICE_NAME ??= 'worker'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { decodeTicket, superviseRabbit } = await import('../shared/queue.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { handleTicket } = await import('./handle.js')

let active = 0
let stopping = false
let consumer: { channel: Channel; tag: string } | null = null

function onMessage(ch: Channel) {
  return (msg: ConsumeMessage | null) => {
    if (!msg) return
    const ticket = decodeTicket(msg.content)
    if (!ticket) {
      logger.error({ content: msg.content.toString().slice(0, 200) }, 'malformed ticket; dead-lettering')
      ch.nack(msg, false, false)
      return
    }
    active += 1
    handleTicket(ticket, msg.fields.redelivered)
      .then((result) => {
        if (result !== 'attempted') logger.debug({ deliveryId: ticket.deliveryId, result }, 'ticket handled without an attempt')
        try {
          ch.ack(msg)
        } catch {
          // Channel died after we committed: the broker redelivers, and the claim drops the stale ticket.
        }
      })
      .catch(async (err: Error) => {
        // PostgreSQL or Valkey trouble: give the ticket back after a pause instead of spinning on it.
        logger.error({ err: err.message, deliveryId: ticket.deliveryId }, 'ticket failed; requeueing')
        await new Promise((r) => setTimeout(r, 1000))
        try {
          ch.nack(msg, false, true)
        } catch {
          // Channel already closed: the broker requeues unacked messages by itself.
        }
      })
      .finally(() => {
        active -= 1
      })
  }
}

const rabbit = superviseRabbit('worker', { confirm: false, prefetch: config.delivery.workerConcurrency }, async (h) => {
  const ch = h.channel as Channel
  const { consumerTag } = await ch.consume(config.queue.deliveries, onMessage(ch))
  consumer = { channel: ch, tag: consumerTag }
  logger.info({ worker: config.instanceId, concurrency: config.delivery.workerConcurrency }, 'delivery worker consuming')
})

const http = startWorkerHttp(config.workerPort, `worker ${config.instanceId}`, async () => {
  await pool.query('SELECT 1')
  await redis.ping()
  if (!rabbit.current()) throw new Error('not connected to RabbitMQ')
})

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal, active }, 'worker stopping: no new tickets, finishing in-flight attempts')
  if (consumer) await consumer.channel.cancel(consumer.tag).catch(() => undefined)
  const deadline = Date.now() + config.delivery.timeoutMs + 2000
  while (active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  await rabbit.close()
  http.close()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
