/**
 * Planner worker: consumes re-plan requests from a Valkey stream with a
 * consumer group (several planner instances can share the load; the per-train
 * lock keeps them off the same train). Also runs the DTL order worker and
 * ticket reconciliation loops.
 * @module planner/worker
 */
import type { Redis } from 'ioredis'
import { createRedisConnection, keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { enqueuePlan, type PlanTrigger } from '../shared/triggers.js'
import { planTrain } from './plan-service.js'

const GROUP = 'planner'

export class PlannerWorker {
  private reader: Redis
  private running = false

  constructor(private consumer = config.instanceId) {
    this.reader = createRedisConnection('planner-reader')
  }

  private async ensureGroup(): Promise<void> {
    try {
      await redis.xgroup('CREATE', keys.planRequests, GROUP, '0', 'MKSTREAM')
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err
    }
  }

  async start(): Promise<void> {
    await this.ensureGroup()
    this.running = true
    await this.planUnplanned()
    void this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.reader.disconnect()
  }

  /** Running trains without a current plan (new trips, or a planner that was down) get one. */
  async planUnplanned(): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT t.id FROM trains t WHERE t.status = 'running' AND NOT EXISTS (SELECT 1 FROM fuel_plans p WHERE p.train_id = t.id AND p.is_current)`,
    )
    for (const r of rows) await enqueuePlan(r.id, 'initial')
  }

  private async loop(): Promise<void> {
    let lastSweep = Date.now()
    while (this.running) {
      try {
        // Reclaim requests a crashed planner took but never acknowledged.
        if (Date.now() - lastSweep > 15_000) {
          lastSweep = Date.now()
          await redis.xautoclaim(keys.planRequests, GROUP, this.consumer, 30_000, '0', 'COUNT', 20)
          await this.planUnplanned()
        }
        const res = (await this.reader.xreadgroup('GROUP', GROUP, this.consumer, 'COUNT', 10, 'BLOCK', 2000, 'STREAMS', keys.planRequests, '>')) as
          | [string, [string, string[]][]][]
          | null
        for (const [, messages] of res ?? []) {
          for (const [id, fields] of messages) {
            const get = (k: string) => fields[fields.indexOf(k) + 1]
            const trainId = get('trainId')
            // Clear the coalescing key first: triggers that arrive during this run queue a fresh run.
            await redis.del(keys.planPending(trainId))
            try {
              await planTrain(trainId, get('trigger') as PlanTrigger, get('detail') ?? '')
              await redis.xack(keys.planRequests, GROUP, id)
            } catch (err) {
              // Left unacknowledged: the reclaim sweep retries it.
              logger.error({ err, trainId }, 'planner run failed')
            }
          }
        }
      } catch (err) {
        if (!this.running) return
        if (String((err as Error).message).includes('NOGROUP')) {
          await this.ensureGroup().catch(() => undefined)
          continue
        }
        logger.error({ err }, 'planner loop error')
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
}
