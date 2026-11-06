/**
 * The outbox relay. It reads committed but unpublished rows from the event
 * log in position order, XADDs each to its partition stream, then marks them
 * published. A crash between XADD and the UPDATE republishes those rows on
 * restart, so delivery is at-least-once and every consumer is idempotent.
 *
 * Every API instance runs a relay, but a PostgreSQL advisory lock lets only
 * one publish at a time. Two concurrent relays could otherwise publish two
 * events of the same quote out of order.
 * @module shared/relay
 */
import type pg from 'pg'
import type { Redis } from 'ioredis'
import { config } from './config.js'
import { pool } from './db.js'
import { logger } from './logger.js'
import { outboxLag, relayPublished } from './metrics.js'
import { partitionKey, partitionOf, xaddEvent } from './stream.js'
import { rowToEnvelope } from './event-store.js'
import { sleep } from './consumer.js'

export class OutboxRelay {
  private running = false
  private leaderClient: pg.PoolClient | null = null

  constructor(private readonly redis: Redis) {}

  start(): void {
    this.running = true
    void this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.leaderClient) {
      await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [config.relay.lockId]).catch(() => undefined)
      this.leaderClient.release()
      this.leaderClient = null
    }
  }

  private async acquireLeadership(): Promise<boolean> {
    if (this.leaderClient) return true
    const client = await pool.connect()
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [config.relay.lockId])
    if (rows[0].ok) {
      this.leaderClient = client
      logger.info({ instance: config.instanceId }, 'outbox relay is leader')
      return true
    }
    client.release()
    return false
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.acquireLeadership())) {
          await sleep(2_000)
          continue
        }
        const published = await this.publishBatch()
        if (published < config.relay.batch) await sleep(config.relay.pollMs)
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'relay error')
        if (this.leaderClient) {
          this.leaderClient.release(true)
          this.leaderClient = null
        }
        await sleep(1_000)
      }
    }
  }

  async publishBatch(): Promise<number> {
    const client = this.leaderClient
    if (!client) return 0
    const { rows } = await client.query('SELECT * FROM events WHERE published_at IS NULL ORDER BY position LIMIT $1', [config.relay.batch])
    if (rows.length === 0) {
      outboxLag.set(0)
      return 0
    }
    for (const row of rows) {
      const env = rowToEnvelope(row)
      const { published_at: _p, position, ...envelope } = env
      await xaddEvent(this.redis, partitionKey(partitionOf(env.stream_id)), {
        event: JSON.stringify(envelope),
        type: env.type,
        position: String(position),
      })
    }
    await client.query('UPDATE events SET published_at = now() WHERE position = ANY($1::bigint[])', [rows.map((r) => r.position)])
    relayPublished.inc(rows.length)
    const { rows: lag } = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events WHERE published_at IS NULL')
    outboxLag.set(lag[0].n)
    return rows.length
  }
}
