/**
 * Helpers for worker processes: a small HTTP server for /health and /metrics,
 * a leader lock in Valkey for singleton loops, and graceful shutdown.
 * @module shared/service
 */
import express from 'express'
import type { Server } from 'node:http'
import type { Redis } from 'ioredis'
import { logger } from './logger.js'
import { metricsHandler } from './metrics.js'

export function startOpsServer(name: string, port: number, extra?: (app: express.Express) => void): Server {
  const app = express()
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: name }))
  app.get('/metrics', metricsHandler)
  extra?.(app)
  return app.listen(port, () => logger.info({ port }, `${name} ops server listening`))
}

/**
 * Leader lock: SET NX PX, renewed while held. Only the holder runs singleton
 * loops (the outbox relay, the timer sweep), so two instances never publish or
 * fire the same thing concurrently. Correctness does not depend on it (all
 * effects are idempotent); ordering and efficiency do.
 */
export class LeaderLock {
  private held = false
  constructor(
    private client: Redis,
    private key: string,
    private owner: string,
    private ttlMs: number,
  ) {}

  async tryAcquire(): Promise<boolean> {
    if (this.held) {
      const renewed = await this.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        this.key,
        this.owner,
        String(this.ttlMs),
      )
      this.held = renewed === 1
      if (this.held) return true
    }
    const ok = await this.client.set(this.key, this.owner, 'PX', this.ttlMs, 'NX')
    this.held = ok === 'OK'
    return this.held
  }

  async release(): Promise<void> {
    if (!this.held) return
    await this.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, this.key, this.owner)
    this.held = false
  }
}

export function onShutdown(fn: () => Promise<void>): void {
  let stopping = false
  const handler = (signal: string) => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'shutting down')
    fn()
      .catch((err) => logger.error({ err }, 'shutdown error'))
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => handler('SIGTERM'))
  process.on('SIGINT', () => handler('SIGINT'))
}
