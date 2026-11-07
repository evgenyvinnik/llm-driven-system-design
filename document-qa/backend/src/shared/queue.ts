/**
 * RabbitMQ topology and connections.
 *
 * One durable quorum queue, `docqa.pipeline`, carries tickets `{ jobId }`.
 * A ticket is a pointer, not the work: the worker re-reads the job row from
 * PostgreSQL and claims it with a conditional UPDATE (status + lease), so
 * stale, duplicate and redelivered tickets are harmless. A ticket redelivered
 * `deliveryLimit` times (a worker died on it each time) is dead-lettered to
 * `docqa.pipeline.poison` instead of crash-looping the fleet; the job row's
 * own attempt counter poisons it in PostgreSQL long before that.
 *
 * Retries do NOT wait in RabbitMQ. A job waiting for its next attempt lives in
 * PostgreSQL with `next_run_at`, and the sweeper re-publishes it when due.
 *
 * Every publisher uses a confirm channel and awaits the broker's confirm.
 * `connectRabbit` resolves only after the topology is asserted, so nothing
 * can publish before the channel is ready (a past bug in this repo lost
 * messages that way). `superviseRabbit` reconnects after a broker restart or a
 * laptop sleep that outlived two heartbeats; without it delivery stops silently.
 * @module shared/queue
 */
import amqplib, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib'
import { config } from './config.js'
import { logger } from './logger.js'

export interface Ticket {
  jobId: string
}

export interface RabbitHandle {
  connection: ChannelModel
  channel: ConfirmChannel
}

export async function assertTopology(ch: Channel): Promise<void> {
  const q = config.queue
  await ch.assertExchange(q.exchange, 'direct', { durable: true })
  await ch.assertQueue(q.poison, { durable: true })
  await ch.assertQueue(q.pipeline, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': q.deliveryLimit,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': q.poison,
    },
  })
  await ch.bindQueue(q.pipeline, q.exchange, q.pipeline)
}

export async function connectRabbit(name: string, prefetch?: number): Promise<RabbitHandle> {
  const connection = await amqplib.connect(config.rabbitUrl, { clientProperties: { connection_name: `${name}-${process.pid}` } })
  connection.on('error', (err) => logger.error({ err: err.message }, 'rabbitmq connection error'))
  const channel = await connection.createConfirmChannel()
  channel.on('error', (err) => logger.error({ err: err.message }, 'rabbitmq channel error'))
  await assertTopology(channel)
  if (prefetch) await channel.prefetch(prefetch)
  return { connection, channel }
}

export function encodeTicket(t: Ticket): Buffer {
  return Buffer.from(JSON.stringify(t))
}

export function decodeTicket(buf: Buffer): Ticket | null {
  try {
    const t = JSON.parse(buf.toString('utf8')) as Partial<Ticket>
    return typeof t.jobId === 'string' ? { jobId: t.jobId } : null
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
 * Keeps one connection + confirm channel alive and calls `onReady` after every
 * (re)connect so the caller can re-register its consumer. Unacked messages
 * from a dead channel are requeued by the broker and redelivered with
 * `redelivered = true`, which the job claim treats as permission to take over
 * the dead holder's lease.
 */
export function superviseRabbit(name: string, prefetch: number | undefined, onReady: (h: RabbitHandle) => Promise<void>): RabbitSupervisor {
  let handle: RabbitHandle | null = null
  let closing = false
  let attempt = 0

  const connect = async (): Promise<void> => {
    while (!closing) {
      try {
        const h = await connectRabbit(name, prefetch)
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

/**
 * Publishes job tickets and waits for broker confirms. Returns false when no
 * connection is up; the caller leaves the job's `dispatched_at` empty and the
 * sweeper publishes it later, so a broker outage delays work but loses none.
 */
export class TicketPublisher {
  private supervisor: RabbitSupervisor

  constructor(name: string) {
    this.supervisor = superviseRabbit(name, undefined, async () => undefined)
  }

  async publish(jobIds: string[]): Promise<boolean> {
    if (jobIds.length === 0) return true
    const h = this.supervisor.current()
    if (!h) return false
    try {
      for (const jobId of jobIds) {
        h.channel.publish(config.queue.exchange, config.queue.pipeline, encodeTicket({ jobId }), { persistent: true, contentType: 'application/json' })
      }
      await h.channel.waitForConfirms()
      return true
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'ticket publish failed; the sweeper will re-dispatch')
      return false
    }
  }

  connected(): boolean {
    return this.supervisor.current() !== null
  }

  close(): Promise<void> {
    return this.supervisor.close()
  }
}
