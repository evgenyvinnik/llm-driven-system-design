/**
 * RabbitMQ topology and connections.
 *
 * One durable quorum queue, `deliveries`, carries work tickets
 * `{ deliveryId, dispatchSeq }`. A ticket is a pointer, not the payload: the
 * worker re-reads the delivery from PostgreSQL and claims it with a
 * conditional update, so stale or duplicate tickets are harmless. A ticket
 * redelivered `deliveryLimit` times (a worker crashed on it each time) is
 * dead-lettered to `deliveries.poison` instead of crash-looping the fleet.
 *
 * Retries do NOT wait in RabbitMQ. A delivery waiting for its next attempt
 * lives in PostgreSQL with `next_attempt_at`, and the scheduler re-dispatches
 * it when due. The queue only ever holds work that is due now.
 *
 * Every publisher uses a confirm channel and awaits the broker's confirm
 * before treating a message as sent. A past bug in this repo published before
 * the channel was ready and lost messages silently; `connectRabbit` resolves
 * only after the topology is asserted, so nothing can publish earlier.
 * @module shared/queue
 */
import amqplib, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib'
import { config } from './config.js'
import { logger } from './logger.js'

export interface Ticket {
  deliveryId: string
  dispatchSeq: number
}

export interface RabbitHandle {
  connection: ChannelModel
  channel: Channel | ConfirmChannel
}

export async function assertTopology(ch: Channel): Promise<void> {
  const q = config.queue
  await ch.assertExchange(q.exchange, 'direct', { durable: true })
  await ch.assertQueue(q.poison, { durable: true })
  await ch.assertQueue(q.deliveries, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': q.deliveryLimit,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': q.poison,
    },
  })
  await ch.bindQueue(q.deliveries, q.exchange, q.deliveries)
}

export async function connectRabbit(name: string, opts: { confirm: boolean; prefetch?: number }): Promise<RabbitHandle> {
  const connection = await amqplib.connect(config.rabbitUrl, { clientProperties: { connection_name: `${name}-${process.pid}` } })
  connection.on('error', (err) => logger.error({ err: err.message }, 'rabbitmq connection error'))
  const channel = opts.confirm ? await connection.createConfirmChannel() : await connection.createChannel()
  channel.on('error', (err) => logger.error({ err: err.message }, 'rabbitmq channel error'))
  await assertTopology(channel)
  if (opts.prefetch) await channel.prefetch(opts.prefetch)
  return { connection, channel }
}

export function encodeTicket(t: Ticket): Buffer {
  return Buffer.from(JSON.stringify(t))
}

export function decodeTicket(buf: Buffer): Ticket | null {
  try {
    const t = JSON.parse(buf.toString('utf8')) as Partial<Ticket>
    if (typeof t.deliveryId === 'string' && typeof t.dispatchSeq === 'number') return { deliveryId: t.deliveryId, dispatchSeq: t.dispatchSeq }
    return null
  } catch {
    return null
  }
}

export interface RabbitSupervisor {
  /** The live connection, or null while reconnecting. */
  current(): RabbitHandle | null
  close(): Promise<void>
}

/**
 * Keeps one connection + channel alive. When the broker connection drops (a
 * broker restart, a network blip, or a laptop that slept past two heartbeats),
 * it reconnects with backoff and calls `onReady` again so the caller can
 * re-register its consumer. Unacked messages from the dead channel are
 * requeued by the broker and redelivered with `redelivered = true`, which the
 * worker's claim handles (it may take over the delivery; at-least-once).
 */
export function superviseRabbit(name: string, opts: { confirm: boolean; prefetch?: number }, onReady: (h: RabbitHandle) => Promise<void>): RabbitSupervisor {
  let handle: RabbitHandle | null = null
  let closing = false
  let attempt = 0

  const connect = async (): Promise<void> => {
    while (!closing) {
      try {
        const h = await connectRabbit(name, opts)
        attempt = 0
        h.connection.on('close', () => {
          if (handle === h) handle = null
          if (closing) return
          logger.warn({ name }, 'rabbitmq connection closed; reconnecting')
          void connect()
        })
        handle = h
        await onReady(h)
        logger.info({ name }, 'rabbitmq connected')
        return
      } catch (err) {
        attempt += 1
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5))
        logger.warn({ err: (err as Error).message, name, attempt, delay }, 'rabbitmq not reachable; retrying')
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  void connect()

  return {
    current: () => handle,
    async close() {
      closing = true
      await handle?.connection.close().catch(() => undefined)
    },
  }
}
