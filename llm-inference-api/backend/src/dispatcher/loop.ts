/**
 * The dispatcher: one active leader (Valkey lease), a tick loop that applies
 * the batch policy per priority class, the fair picker inside a class, and
 * the sweeps that keep the system honest after failures:
 * - expiry:   requests whose deadline passed while queued are failed with a
 *             full refund (their caller has given up; don't spend capacity);
 * - recovery: in-flight entries no live dispatcher owns (a crashed leader) are
 *             re-queued if no output started, failed if it had;
 * - orphans:  records stuck in `queued` that never made it into a queue.
 * A standby instance takes over within LEADER_TTL_MS of the leader dying.
 * @module dispatcher/loop
 */
import { CLASSES, createRedisConnection, keys, redis, runScript, type PriorityClass } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { finished, queueDepth } from '../shared/metrics.js'
import { appendEvent, finalizeUnstarted, finalizeUsage, getRequest, loadJob, transition, type RequestRow } from '../shared/requests.js'
import { getRuntimeConfig } from '../shared/runtime-config.js'
import { BackendRegistry } from './backends.js'
import { classCapacity, decideDispatch } from './batch-policy.js'
import { Executor } from './executor.js'
import { FairPicker } from './fairness.js'
import { claim, classState, release, requeue, tenantViews } from './queues.js'
import { HashRing } from './router.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Dispatcher {
  readonly registry = new BackendRegistry()
  readonly ring = new HashRing(this.registry.ids, config.dispatcher.virtualNodes)
  readonly executor = new Executor(this.registry, this.ring)
  private pickers: Record<PriorityClass, FairPicker> = { interactive: new FairPicker(), batch: new FairPicker() }
  isLeader = false
  private running = false
  private timers: NodeJS.Timeout[] = []
  private sub = createRedisConnection('dispatcher-sub')

  async start(): Promise<void> {
    this.running = true
    await this.registry.pollOnce()
    await this.elect()
    this.timers.push(setInterval(() => void this.elect(), Math.max(200, Math.floor(config.dispatcher.leaderTtlMs / 3))))
    this.timers.push(setInterval(() => void this.poll(), config.dispatcher.healthPollMs))
    this.timers.push(setInterval(() => void this.guard('expiry', () => this.expire()), 250))
    this.timers.push(setInterval(() => void this.guard('recovery', () => this.recover()), 5000))
    this.timers.push(setInterval(() => void this.guard('orphans', () => this.orphans()), 10_000))
    await this.sub.subscribe(keys.cancelChannel)
    this.sub.on('message', (_channel, message) => {
      try {
        const { id } = JSON.parse(message) as { id: string }
        void this.executor.onCancel(id)
      } catch {
        // ignore malformed messages
      }
    })
    void this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    for (const t of this.timers) clearInterval(t)
    this.sub.disconnect()
    if (this.isLeader) await redis.del(keys.leader).catch(() => undefined)
  }

  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (!this.isLeader) return
    try {
      await fn()
    } catch (err) {
      logger.warn({ err, sweep: name }, 'sweep failed')
    }
  }

  private async elect(): Promise<void> {
    try {
      const ttl = config.dispatcher.leaderTtlMs
      if (this.isLeader) {
        const ok = await runScript<number>('RENEW', [keys.leader], [config.instanceId, ttl])
        if (!ok) {
          this.isLeader = false
          logger.warn('lost dispatcher leadership')
        }
      } else {
        const ok = await redis.set(keys.leader, config.instanceId, 'PX', ttl, 'NX')
        if (ok) {
          this.isLeader = true
          logger.info({ instance: config.instanceId }, 'became dispatcher leader')
        }
      }
    } catch (err) {
      logger.warn({ err }, 'leader election failed')
    }
  }

  private async poll(): Promise<void> {
    await this.registry.pollOnce()
    if (this.isLeader) await this.registry.publish().catch(() => undefined)
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (this.isLeader) await this.tick()
      } catch (err) {
        logger.error({ err }, 'dispatch tick failed')
        await sleep(200)
      }
      await sleep(config.dispatcher.tickMs)
    }
  }

  /** One scheduling decision per class: interactive first, then bulk with what is left. */
  async tick(): Promise<void> {
    const rc = await getRuntimeConfig()
    const now = Date.now()
    const [qi, qb] = await Promise.all([classState('interactive'), classState('batch')])
    queueDepth.set({ class: 'interactive' }, qi.depth)
    queueDepth.set({ class: 'batch' }, qb.depth)
    if (qi.depth === 0 && qb.depth === 0) return

    const capacity = this.registry.capacity(now)
    const total = capacity.total
    let free = capacity.free
    const cap = classCapacity(free, total, this.executor.inFlightCount('batch'), qi.depth > 0, qb.depth > 0, rc.batchMinShare, rc.batchMaxShare)
    const di = decideDispatch(qi, cap.interactive, { batchMaxSize: rc.batchMaxSize, maxWaitMs: rc.interactiveMaxWaitMs, deadlineSlackMs: rc.deadlineSlackMs }, now)
    if (di) free -= await this.dispatchClass('interactive', di)

    const capB = classCapacity(Math.max(0, free), total, this.executor.inFlightCount('batch'), qi.depth > (di?.size ?? 0), qb.depth > 0, rc.batchMinShare, rc.batchMaxShare)
    const db = decideDispatch(qb, capB.batch, { batchMaxSize: rc.batchMaxSize, maxWaitMs: rc.batchMaxWaitMs, deadlineSlackMs: rc.deadlineSlackMs }, now)
    if (db) await this.dispatchClass('batch', db)
  }

  private async dispatchClass(cls: PriorityClass, decision: NonNullable<ReturnType<typeof decideDispatch>>): Promise<number> {
    const rc = await getRuntimeConfig()
    const { views, jobs } = await tenantViews(cls, decision.size)
    const picks = this.pickers[cls].pick(views, decision.size)
    const claimed = await claim(cls, picks)
    const ready = []
    for (const id of claimed) {
      const job = jobs.get(id)
      if (job) ready.push(job)
      else {
        await transition(pool, id, 'failed', { error_type: 'api_error', error_message: 'job payload expired before dispatch', finished_at: new Date() })
        await release(id)
      }
    }
    return this.executor.dispatch(ready, decision, rc)
  }

  /** Requests whose deadline passed while still queued: fail them and refund in full. */
  private async expire(): Promise<void> {
    const now = Date.now()
    for (const cls of CLASSES) {
      const ids = await redis.zrangebyscore(keys.deadline(cls), '-inf', now, 'LIMIT', 0, 50)
      for (const id of ids) {
        const job = await loadJob(id)
        const row = await transition(pool, id, 'failed', { error_type: 'timeout_error', error_message: 'Deadline passed while the request was queued.', finished_at: new Date() })
        const orgId = job?.orgId ?? row?.org_id
        if (orgId) {
          await runScript('UNQUEUE', [keys.age(cls), keys.deadline(cls), keys.tenantQueue(cls, orgId), keys.tenants(cls), keys.job(id)], [id, orgId])
        } else {
          await redis.multi().zrem(keys.age(cls), id).zrem(keys.deadline(cls), id).exec()
        }
        if (row && job) {
          await finalizeUnstarted(job, 'failed')
          finished.inc({ status: 'failed', error_type: 'timeout_error' })
          await appendEvent(id, 'error', { type: 'timeout_error', message: 'Deadline passed while the request was queued.' })
        }
      }
    }
  }

  /** In-flight entries no live flight owns: a previous leader died holding them. */
  private async recover(): Promise<void> {
    const stale = await redis.zrangebyscore(keys.inflight, '-inf', Date.now() - config.dispatcher.recoverAfterMs, 'LIMIT', 0, 100)
    for (const id of stale) {
      if (this.executor.flights.has(id)) continue
      const row = await getRequest(pool, id)
      const job = await loadJob(id)
      if (!row || !job) {
        await release(id)
        continue
      }
      if (row.status === 'queued') {
        await requeue([job])
        await appendEvent(id, 'requeued', { reason: 'dispatcher_recovered', fromBackend: row.backend_id })
      } else if (row.status === 'running') {
        const message = 'The dispatcher handling this request stopped after output had started; the request cannot move. Retry it.'
        if (await transition(pool, id, 'failed', { error_type: 'api_error', error_message: message, finished_at: new Date() })) {
          await finalizeUsage(job, { status: 'failed', inputTokens: job.inputTokens, cachedTokens: 0, outputTokens: 0, queueMs: null, ttftMs: null, execMs: null, totalMs: Date.now() - job.enqueuedAt, tokensPerSec: null })
          await appendEvent(id, 'error', { type: 'api_error', message })
        }
        await release(id)
      } else {
        await finalizeUnstarted(job, row.status)
        await release(id)
      }
    }
  }

  /** Durable records that never reached a queue (the gateway died between insert and admit). */
  private async orphans(): Promise<void> {
    const { rows } = await pool.query<RequestRow>(
      `SELECT * FROM requests WHERE status = 'queued' AND created_at < now() - ($1 || ' milliseconds')::interval ORDER BY created_at LIMIT 100`,
      [String(config.dispatcher.orphanAfterMs)],
    )
    for (const row of rows) {
      if (this.executor.flights.has(row.id)) continue
      const [inQueue, inFlight] = await Promise.all([redis.zscore(keys.age(row.priority_class), row.id), redis.zscore(keys.inflight, row.id)])
      if (inQueue !== null || inFlight !== null) continue
      const message = 'Admission did not complete for this request.'
      if (await transition(pool, row.id, 'failed', { error_type: 'api_error', error_message: message, finished_at: new Date() })) {
        await appendEvent(row.id, 'error', { type: 'api_error', message })
      }
    }
  }
}
