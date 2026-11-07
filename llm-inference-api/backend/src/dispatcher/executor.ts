/**
 * Executes dispatched batches: routes each request, records the batch, sends
 * one group per backend, and turns the backend's NDJSON stream into state
 * transitions and per-request events.
 *
 * Rules this file enforces:
 * - The first token moves queued → running with a guarded UPDATE *before* the
 *   token is published. If a cancel won first, the token is never shown and
 *   the backend is told to stop.
 * - Before the first token a request is not pinned: a refusal, a full backend
 *   or a crashed stream puts it back at the head of its tenant queue and it
 *   is routed again (up to DISPATCH_MAX_ATTEMPTS).
 * - After the first token it is pinned: if that backend's stream breaks, the
 *   request fails with a clear error. Output is never stitched across backends.
 * - Completion is running → completed, guarded the same way; the loser of a
 *   cancel/complete race writes nothing to the event log.
 * @module dispatcher/executor
 */
import { randomUUID } from 'node:crypto'
import { redis } from '../shared/cache.js'
import { config, type RuntimeConfig } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { batchSize, finished, queueSeconds, reroutes, routeDecisions, tokensPerSecond, totalSeconds, ttftSeconds } from '../shared/metrics.js'
import { appendEvent, finalizeUnstarted, finalizeUsage, transition, type Job, type UsageFacts } from '../shared/requests.js'
import type { RequestStatus } from '../shared/state-machine.js'
import type { EngineEvent } from '../backend/engine.js'
import type { BackendRegistry } from './backends.js'
import type { BatchTrigger, DispatchDecision } from './batch-policy.js'
import { release, requeue } from './queues.js'
import { route, type HashRing } from './router.js'

interface Flight {
  job: Job
  backendId: string
  batchId: string
  affinity: 'primary' | 'spill'
  attempts: number
  sentAt: number
  acceptedAt: number | null
  firstTokenAt: number | null
  started: boolean
  /** The first-token transition lost to a cancel/expiry. */
  lostRace: boolean
  cancelRequested: boolean
  finished: boolean
  cachedTokens: number
  inputTokens: number
  version: string | null
  text: string
  outputTokens: number
  chain: Promise<void>
}

type Pending = ['start' | 'delta', Record<string, unknown>]

export class Executor {
  readonly flights = new Map<string, Flight>()

  constructor(
    private registry: BackendRegistry,
    private ring: HashRing,
  ) {}

  inFlightCount(cls: Job['cls']): number {
    let n = 0
    for (const f of this.flights.values()) if (f.job.cls === cls) n++
    return n
  }

  /** Routes and sends one batch of claimed jobs. Returns how many went to a backend. */
  async dispatch(jobs: Job[], decision: DispatchDecision, rc: RuntimeConfig): Promise<number> {
    if (jobs.length === 0) return 0
    const loads = this.registry.loads()
    const opts = { epsilon: config.dispatcher.loadEpsilon, lowLoadFraction: config.dispatcher.lowLoadFraction }
    const routed: { job: Job; backendId: string; affinity: 'primary' | 'spill' }[] = []
    const unroutable: Job[] = []
    for (const job of jobs) {
      const d = route(this.ring, job.prefixKey, loads, opts)
      if (!d) {
        unroutable.push(job)
        continue
      }
      const l = loads.get(d.backendId)
      if (l) l.inUse++
      routed.push({ job, backendId: d.backendId, affinity: d.affinity })
    }
    if (unroutable.length > 0) await this.putBack(unroutable, 'no_capacity', null)
    if (routed.length === 0) return 0

    const batchId = randomUUID()
    const { rows } = await pool.query<{ id: string; attempts: number }>(
      `UPDATE requests r SET backend_id = v.backend, affinity = v.affinity, batch_id = $4, attempts = r.attempts + 1, dispatched_at = now()
       FROM unnest($1::text[], $2::text[], $3::text[]) AS v(id, backend, affinity)
       WHERE r.id = v.id AND r.status = 'queued' RETURNING r.id, r.attempts`,
      [routed.map((r) => r.job.id), routed.map((r) => r.backendId), routed.map((r) => r.affinity), batchId],
    )
    const attempts = new Map(rows.map((r) => [r.id, r.attempts]))
    const live: typeof routed = []
    for (const r of routed) {
      const n = attempts.get(r.job.id)
      if (n === undefined) {
        // Cancelled between claim and now; the canceller left the finalization to us.
        await finalizeUnstarted(r.job, 'cancelled')
        await release(r.job.id)
      } else if (n > config.dispatcher.maxAttempts) {
        await this.failUnstarted(r.job, 'overloaded_error', `No backend accepted the request after ${n - 1} attempts.`)
      } else {
        live.push(r)
        routeDecisions.inc({ affinity: r.affinity })
      }
    }
    if (live.length === 0) return 0

    const byBackend: Record<string, number> = {}
    for (const r of live) byBackend[r.backendId] = (byBackend[r.backendId] ?? 0) + 1
    await pool.query(
      'INSERT INTO batches (id, priority_class, size, max_size, trigger, oldest_wait_ms, backends) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [batchId, live[0].job.cls, live.length, rc.batchMaxSize, decision.trigger satisfies BatchTrigger, Math.round(decision.oldestWaitMs), JSON.stringify(byBackend)],
    )
    batchSize.observe({ class: live[0].job.cls, trigger: decision.trigger }, live.length)

    for (const backendId of Object.keys(byBackend)) {
      const group = live.filter((r) => r.backendId === backendId)
      for (const r of group) {
        this.flights.set(r.job.id, {
          job: r.job, backendId, batchId, affinity: r.affinity, attempts: attempts.get(r.job.id) as number,
          sentAt: Date.now(), acceptedAt: null, firstTokenAt: null, started: false, lostRace: false, cancelRequested: false,
          finished: false, cachedTokens: 0, inputTokens: r.job.inputTokens, version: null, text: '', outputTokens: 0, chain: Promise.resolve(),
        })
      }
      this.registry.addInflight(backendId, group.length)
      void this.sendGroup(backendId, batchId, group.map((r) => r.job)).catch((err) => logger.error({ err, backendId }, 'group failed'))
    }
    return live.length
  }

  private async sendGroup(backendId: string, batchId: string, jobs: Job[]): Promise<void> {
    const ids = jobs.map((j) => j.id)
    let resp: globalThis.Response
    try {
      resp = await fetch(`${this.registry.url(backendId)}/v1/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batchId,
          items: jobs.map((j) => ({ id: j.id, prefixKey: j.prefixKey, prefixTokens: j.prefixTokens, inputTokens: j.inputTokens, maxTokens: j.maxTokens, seed: j.seed, outputTokens: j.outputTokens })),
        }),
      })
    } catch {
      this.registry.markRefused(backendId, 'unreachable', 0)
      await this.requeueFlights(ids, 'backend_unreachable')
      return
    }
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { reason?: string }
      const reason = body.reason ?? `http_${resp.status}`
      this.registry.markRefused(backendId, reason, resp.status)
      await this.requeueFlights(ids, `backend_${reason}`)
      return
    }

    let streamError = false
    try {
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        await this.handleLines(backendId, lines.filter(Boolean))
      }
    } catch {
      streamError = true
    }
    if (streamError) this.registry.markStreamLost(backendId)
    await this.handleGroupEnd(ids, backendId, streamError)
  }

  private async handleLines(backendId: string, lines: string[]): Promise<void> {
    const perFlight = new Map<string, EngineEvent[]>()
    for (const line of lines) {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (msg.t === 'admitted') {
        const now = Date.now()
        for (const id of msg.ids as string[]) {
          const f = this.flights.get(id)
          if (f) f.acceptedAt = now
        }
        const rejected = (msg.rejected as { id: string; reason: string }[]) ?? []
        if (rejected.length > 0) await this.requeueFlights(rejected.map((r) => r.id), `backend_${rejected[0].reason}`)
        continue
      }
      const ev = msg as unknown as EngineEvent
      const list = perFlight.get(ev.id)
      if (list) list.push(ev)
      else perFlight.set(ev.id, [ev])
    }
    for (const [id, evs] of perFlight) {
      const f = this.flights.get(id)
      if (!f || f.backendId !== backendId) continue
      f.chain = f.chain.then(() => this.handleEvents(f, evs)).catch((err) => logger.error({ err, id }, 'event handling failed'))
    }
  }

  /** Applies one chunk of a request's events, in order. Deltas are published in one pipeline. */
  private async handleEvents(f: Flight, evs: EngineEvent[]): Promise<void> {
    const pending: Pending[] = []
    const flush = async () => {
      if (pending.length === 0) return
      const m = redis.multi()
      const key = `${config.keyPrefix}ev:${f.job.id}`
      for (const [type, data] of pending) m.xadd(key, 'MAXLEN', '~', '5000', '*', 'e', type, 'd', JSON.stringify(data))
      m.expire(key, 3600)
      pending.length = 0
      await m.exec()
    }
    for (const ev of evs) {
      if (f.finished) return
      if (ev.t === 'first') {
        f.firstTokenAt = Date.now()
        f.acceptedAt ??= f.sentAt
        f.cachedTokens = ev.cachedTokens
        f.inputTokens = ev.inputTokens
        f.version = ev.version
        f.text += ev.text
        f.outputTokens = 1
        const row = await transition(pool, f.job.id, 'running', { first_token_at: new Date(f.firstTokenAt), model_version: ev.version, backend_id: f.backendId })
        if (!row) {
          f.lostRace = true
          void this.cancelOnBackend(f)
          continue
        }
        f.started = true
        pending.push([
          'start',
          {
            backendId: f.backendId, version: ev.version, cachedTokens: ev.cachedTokens, inputTokens: ev.inputTokens, affinity: f.affinity,
            attempts: f.attempts, queueMs: f.acceptedAt - f.job.enqueuedAt, ttftMs: f.firstTokenAt - f.acceptedAt,
          },
        ])
        pending.push(['delta', { text: ev.text }])
      } else if (ev.t === 'tok') {
        f.text += ev.text
        f.outputTokens++
        if (f.started) pending.push(['delta', { text: ev.text }])
      } else if (ev.t === 'done') {
        f.outputTokens = ev.outputTokens
        await flush()
        await this.complete(f, ev.stopReason)
        return
      } else if (ev.t === 'cancelled') {
        f.outputTokens = ev.outputTokens
        await flush()
        await this.finishCancelled(f)
        return
      }
    }
    await flush()
  }

  private facts(f: Flight, status: RequestStatus, end = Date.now()): UsageFacts {
    const accepted = f.acceptedAt ?? f.sentAt
    const tps = f.firstTokenAt && f.outputTokens > 1 && end > f.firstTokenAt ? (f.outputTokens - 1) / ((end - f.firstTokenAt) / 1000) : null
    return {
      status,
      inputTokens: f.firstTokenAt ? f.inputTokens : 0,
      cachedTokens: f.firstTokenAt ? f.cachedTokens : 0,
      outputTokens: f.outputTokens,
      queueMs: Math.max(0, accepted - f.job.enqueuedAt),
      ttftMs: f.firstTokenAt ? f.firstTokenAt - accepted : null,
      execMs: end - accepted,
      totalMs: end - f.job.enqueuedAt,
      tokensPerSec: tps,
    }
  }

  private observe(f: Flight, facts: UsageFacts): void {
    const cls = f.job.cls
    if (facts.queueMs !== null) queueSeconds.observe({ class: cls }, facts.queueMs / 1000)
    if (facts.ttftMs !== null) ttftSeconds.observe({ class: cls, cache: f.cachedTokens > 0 ? 'hit' : 'miss' }, facts.ttftMs / 1000)
    if (facts.tokensPerSec !== null) tokensPerSecond.observe({ class: cls }, facts.tokensPerSec)
    if (facts.totalMs !== null) totalSeconds.observe({ class: cls, status: facts.status }, facts.totalMs / 1000)
  }

  private async complete(f: Flight, stopReason: string): Promise<void> {
    f.finished = true
    const end = Date.now()
    if (f.lostRace) {
      await this.finishCancelled(f)
      return
    }
    const row = await transition(pool, f.job.id, 'completed', { output_text: f.text, stop_reason: stopReason, finished_at: new Date(end) })
    if (!row) {
      // A cancel won the race; its terminal event is already in the log.
      await this.saveCancelled(f)
      return
    }
    const facts = this.facts(f, 'completed', end)
    await finalizeUsage(f.job, facts)
    this.observe(f, facts)
    finished.inc({ status: 'completed', error_type: '' })
    await appendEvent(f.job.id, 'done', {
      stopReason,
      backendId: f.backendId,
      modelVersion: f.version,
      usage: { input_tokens: facts.inputTokens, output_tokens: facts.outputTokens, cache_read_input_tokens: facts.cachedTokens },
      latency: { queue_ms: facts.queueMs, ttft_ms: facts.ttftMs, exec_ms: facts.execMs, total_ms: facts.totalMs, tokens_per_sec: facts.tokensPerSec === null ? null : Math.round(facts.tokensPerSec * 10) / 10 },
    })
    await this.drop(f)
  }

  private async finishCancelled(f: Flight): Promise<void> {
    f.finished = true
    await this.saveCancelled(f)
  }

  /** The request is cancelled in PostgreSQL: keep the partial output, bill what was generated, refund the rest. */
  private async saveCancelled(f: Flight): Promise<void> {
    f.finished = true
    if (f.text) await pool.query(`UPDATE requests SET output_text = $2 WHERE id = $1 AND status = 'cancelled' AND output_text IS NULL`, [f.job.id, f.text])
    const facts = this.facts(f, 'cancelled')
    await finalizeUsage(f.job, facts)
    finished.inc({ status: 'cancelled', error_type: '' })
    await this.drop(f)
  }

  private async drop(f: Flight): Promise<void> {
    if (this.flights.get(f.job.id) === f) this.flights.delete(f.job.id)
    this.registry.releaseInflight(f.backendId)
    await release(f.job.id)
  }

  private async failUnstarted(job: Job, type: string, message: string): Promise<void> {
    const row = await transition(pool, job.id, 'failed', { error_type: type, error_message: message, finished_at: new Date() })
    if (row) {
      await finalizeUnstarted(job, 'failed')
      finished.inc({ status: 'failed', error_type: type })
      await appendEvent(job.id, 'error', { type, message })
    }
    await release(job.id)
  }

  /** Puts not-yet-started requests back in their queue (head of their tenant FIFO). */
  private async putBack(jobs: Job[], reason: string, fromBackend: string | null): Promise<void> {
    await requeue(jobs)
    for (const j of jobs) {
      reroutes.inc({ reason })
      await appendEvent(j.id, 'requeued', { reason, fromBackend })
    }
  }

  private async requeueFlights(ids: string[], reason: string): Promise<void> {
    const back: Job[] = []
    let from: string | null = null
    for (const id of ids) {
      const f = this.flights.get(id)
      if (!f || f.finished) continue
      from = f.backendId
      await f.chain
      if (f.finished || f.started || f.firstTokenAt) continue
      f.finished = true
      this.flights.delete(id)
      this.registry.releaseInflight(f.backendId)
      if (f.cancelRequested) {
        await finalizeUnstarted(f.job, 'cancelled')
        await release(id)
      } else back.push(f.job)
    }
    if (back.length > 0) await this.putBack(back, reason, from)
  }

  /** The group's stream ended. Anything unfinished either fails (output began) or is re-routed. */
  private async handleGroupEnd(ids: string[], backendId: string, streamError: boolean): Promise<void> {
    const back: string[] = []
    for (const id of ids) {
      const f = this.flights.get(id)
      if (!f || f.finished || f.backendId !== backendId) continue
      await f.chain
      if (f.finished) continue
      if (f.lostRace) {
        await this.finishCancelled(f)
      } else if (f.started) {
        f.finished = true
        const message = `Backend ${backendId} failed after ${f.outputTokens} output tokens. Output had started, so the request cannot move to another backend; retry it.`
        const row = await transition(pool, id, 'failed', { error_type: 'api_error', error_message: message, output_text: f.text, finished_at: new Date() })
        if (row) {
          const facts = this.facts(f, 'failed')
          await finalizeUsage(f.job, facts)
          finished.inc({ status: 'failed', error_type: 'api_error' })
          await appendEvent(id, 'error', { type: 'api_error', message, backendId, outputTokens: f.outputTokens })
        } else {
          await this.saveCancelled(f)
        }
        await this.drop(f)
      } else {
        back.push(id)
      }
    }
    if (back.length > 0) await this.requeueFlights(back, streamError ? 'backend_crashed' : 'backend_stream_ended')
  }

  /** Cancel message from a gateway: stop the sequence on its backend. */
  async onCancel(id: string): Promise<void> {
    const f = this.flights.get(id)
    if (!f) return
    f.cancelRequested = true
    await this.cancelOnBackend(f)
  }

  private async cancelOnBackend(f: Flight): Promise<void> {
    try {
      await fetch(`${this.registry.url(f.backendId)}/v1/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [f.job.id] }),
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      // The backend is gone; its stream end will finalize the request.
    }
  }
}
