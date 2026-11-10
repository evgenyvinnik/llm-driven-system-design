/**
 * The yard simulator: everything outside the system's control. Trains arrive,
 * crews work the published list at their own pace, things go wrong. Every random
 * draw depends only on (seed, label), so a run is reproducible, and it reads the
 * plan the same way a real crew does: through the API.
 *
 * Its clock is its own. Simulated time goes to the yard through the clock
 * endpoint, and all planning runs on that simulated time. The database clock is
 * only used for leases and retries.
 * @module simulator/engine
 */
import { createHash } from 'node:crypto'
import { MIN } from '../domain/params.js'
import { generateShift, shiftStart } from '../domain/scenario.js'
import { crewFactor } from '../replay/engine.js'
import { draw } from '../shared/rng.js'
import type { CrewReport } from '../execution/reports.js'
import type { SimMove, SimView, YardPort } from './port.js'

export interface SimOptions {
  seed: number
  exceptionRate: number
  autoRoll: boolean
}

interface InFlight {
  key: string
  move: SimMove
  finishAt: number
}

interface PendingReport {
  deliverAt: number
  report: CrewReport
  reporter: string
}

export class YardSimulator {
  seed: number
  exceptionRate: number
  autoRoll: boolean
  now = 0
  log: string[] = []
  dropNext = 0
  private crews: { hump: InFlight | null; trim: InFlight | null } = { hump: null, trim: null }
  private delayed: PendingReport[] = []
  private reopen: { at: number; trackId: string }[] = []
  private refused = new Set<string>()

  constructor(
    private port: YardPort,
    options: SimOptions,
  ) {
    this.seed = options.seed
    this.exceptionRate = options.exceptionRate
    this.autoRoll = options.autoRoll
  }

  reset(seed: number, exceptionRate: number) {
    this.seed = seed
    this.exceptionRate = exceptionRate
    this.now = shiftStart(1)
    this.log = []
    this.dropNext = 0
    this.crews = { hump: null, trim: null }
    this.delayed = []
    this.reopen = []
    this.refused = new Set()
  }

  /** Picks up the clock and any in-flight crew work after a restart. */
  async attach(): Promise<void> {
    const view = await this.port.view()
    this.now = new Date(view.now).getTime()
    this.seed = view.seed
    for (const f of view.simInFlight) {
      const crew = f.crew_name.endsWith('hump') ? 'hump' : 'trim'
      this.crews[crew] = { key: f.key, move: f.move, finishAt: Math.max(this.now + MIN, Number(f.move.plannedEnd)) }
    }
  }

  record(line: string) {
    const stamp = new Date(this.now).toISOString().slice(0, 16)
    this.log.push(`${stamp} ${line}`)
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000)
  }

  digest(): string {
    return createHash('sha256').update(this.log.join('\n')).digest('hex')
  }

  scenarioDigest(shiftIndex = 1): string {
    return createHash('sha256').update(JSON.stringify(generateShift(this.seed, shiftIndex))).digest('hex')
  }

  get crewState() {
    const c = (x: InFlight | null) => (x ? { key: x.key, finishAt: new Date(x.finishAt).toISOString() } : null)
    return { hump: c(this.crews.hump), trim: c(this.crews.trim) }
  }

  get delayedReports() {
    return this.delayed.length
  }

  private reportId(shift: number, key: string, kind: string) {
    return `sim-${this.seed}-${shift}-${key}-${kind}`
  }

  /** The crew's phone lost signal: the next report(s) sync later, in reverse order. */
  dropReports(count: number) {
    this.dropNext += count
    this.record(`scenario drop-report ${count}`)
  }

  private async send(report: CrewReport, reporter: string): Promise<void> {
    if (this.dropNext > 0 && report.kind !== 'start') {
      this.dropNext--
      // Later reports get an earlier delivery time, so a backlog syncs out of order.
      const deliverAt = this.now + (20 + this.dropNext * 5) * MIN
      this.delayed.push({ deliverAt, report: { ...report, offline: true }, reporter })
      this.record(`report withheld ${report.moveKey} ${report.kind}`)
      return
    }
    const out = await this.port.report(report, reporter)
    this.record(`report ${report.moveKey ?? '-'} ${report.kind}${report.exceptionType ? `:${report.exceptionType}` : ''} ${out.outcome}`)
  }

  /** Advances simulated time by one step and does whatever is due. */
  async tick(stepMs: number): Promise<void> {
    this.now += stepMs
    const nowIso = new Date(this.now).toISOString()
    await this.port.clock(nowIso)
    let view = await this.port.view()
    const shift = view.shiftId

    for (const d of this.delayed.filter((x) => x.deliverAt <= this.now)) {
      const out = await this.port.report(d.report, d.reporter)
      this.record(`report synced ${d.report.moveKey} ${d.report.kind} ${out.outcome}`)
    }
    this.delayed = this.delayed.filter((x) => x.deliverAt > this.now)

    for (const r of this.reopen.filter((x) => x.at <= this.now)) {
      await this.port.trackStatus(r.trackId, true, 'cleared')
      this.record(`track reopened ${r.trackId}`)
    }
    this.reopen = this.reopen.filter((x) => x.at > this.now)

    // Crews finish.
    for (const name of ['hump', 'trim'] as const) {
      const job = this.crews[name]
      if (!job || job.finishAt > this.now) continue
      this.crews[name] = null
      await this.finish(job, name, shift)
    }

    // Trains arrive and leave.
    for (const i of view.inbound) {
      if (i.actual_arrival) continue
      const due = new Date(i.eta).getTime() + Math.round((draw(this.seed, `arr|${i.id}`) - 0.3) * 20) * MIN
      if (due > this.now) continue
      const out = await this.port.arrival(i.id, nowIso)
      this.record(`arrived ${i.id} on ${out.trackId}`)
    }
    for (const o of view.outbound) {
      if (o.status !== 'planned' || new Date(o.departure).getTime() > this.now) continue
      const out = await this.port.departure(o.id, nowIso)
      this.record(`departure ${o.id} ${out.status} ${out.cars ?? 0}`)
    }

    // Crews take their next ready move from the published list.
    view = await this.port.view()
    for (const name of ['hump', 'trim'] as const) {
      if (this.crews[name]) continue
      const next = view.moves.find((m) => m.crew === name && m.status === 'pending' && m.ready && new Date(m.plannedStart).getTime() <= this.now && !this.refused.has(`${m.key}|${view.versionNo}`))
      if (!next) continue
      const reporter = `crew-sim-${name}`
      const out = await this.port.report({ clientReportId: `${this.reportId(view.shiftId, next.key, 'start')}-v${view.versionNo}`, moveKey: next.key, kind: 'start', occurredAt: nowIso }, reporter)
      if (out.outcome !== 'applied' && out.outcome !== 'already_started') {
        this.refused.add(`${next.key}|${view.versionNo}`)
        this.record(`start refused ${next.key} ${out.outcome}`)
        continue
      }
      const planned = new Date(next.plannedEnd).getTime() - new Date(next.plannedStart).getTime()
      const dur = Math.max(MIN, Math.round((planned * crewFactor(this.seed, next.key)) / MIN) * MIN)
      this.crews[name] = { key: next.key, move: next, finishAt: this.now + dur }
      this.record(`start ${next.key}`)
    }

    if (this.autoRoll && view.shiftEndsAt && this.now >= new Date(view.shiftEndsAt).getTime() + 15 * MIN) {
      const rolled = await this.port.nextShift()
      this.crews = { hump: null, trim: null }
      this.record(`shift ${rolled.closed} closed, ${rolled.opened} opened`)
    }
  }

  private async finish(job: InFlight, name: 'hump' | 'trim', shift: number): Promise<void> {
    const reporter = `crew-sim-${name}`
    const occurredAt = new Date(this.now).toISOString()
    const m = job.move
    const exceptionDraw = draw(this.seed, `exc|${shift}|${m.key}`)
    if (exceptionDraw < this.exceptionRate && m.carIds.length > 1 && m.kind !== 'setout') {
      const kindDraw = draw(this.seed, `exckind|${shift}|${m.key}`)
      if (kindDraw < 0.5) {
        await this.send({ clientReportId: this.reportId(shift, m.key, 'exc-notfound'), moveKey: m.key, kind: 'exception', exceptionType: 'car_not_found', carIds: [m.carIds[m.carIds.length - 1]], occurredAt }, reporter)
        return
      }
      if (kindDraw < 0.8) {
        await this.send({ clientReportId: this.reportId(shift, m.key, 'exc-different'), moveKey: m.key, kind: 'exception', exceptionType: 'different_cars', carIds: m.carIds.slice(0, -1), occurredAt }, reporter)
        return
      }
      if (m.kind === 'classify') {
        await this.send({ clientReportId: this.reportId(shift, m.key, 'exc-track'), moveKey: m.key, kind: 'exception', exceptionType: 'track_blocked', trackId: m.toTrackId, note: 'switch points fouled', occurredAt }, reporter)
        this.reopen.push({ at: this.now + 60 * MIN, trackId: m.toTrackId })
        return
      }
    }
    await this.send({ clientReportId: this.reportId(shift, m.key, 'complete'), moveKey: m.key, kind: 'complete', occurredAt }, reporter)
  }

  /** Runs simulated minutes one step at a time, letting the planner catch up between steps. */
  async step(minutes: number, stepMin = 1, settle = true): Promise<void> {
    const steps = Math.max(1, Math.round(minutes / stepMin))
    for (let i = 0; i < steps; i++) {
      await this.tick(stepMin * MIN)
      if (settle) await this.port.settle()
    }
  }

  // ── Scenario controls ─────────────────────────────────────────────────

  async lateTrain(view: SimView, inboundId: string | undefined, minutes: number) {
    const candidates = view.inbound.filter((i) => !i.actual_arrival)
    const train = inboundId ? view.inbound.find((i) => i.id === inboundId) : candidates[0]
    if (!train) throw new Error('No inbound train left to delay')
    const eta = new Date(new Date(train.eta).getTime() + minutes * MIN).toISOString()
    const out = await this.port.slip(train.id, eta, `simulated: ${minutes} min late`)
    this.record(`scenario late-train ${train.id} +${minutes}`)
    return { inboundId: train.id, eta, ...out }
  }

  async blockTrack(trackId: string, reopenAfterMin: number | null, reason = 'simulated: switch out of service') {
    const out = await this.port.trackStatus(trackId, false, reason)
    if (reopenAfterMin) this.reopen.push({ at: this.now + reopenAfterMin * MIN, trackId })
    this.record(`scenario block-track ${trackId}`)
    return out
  }
}

export function chooseHoldCar(view: SimView, requested: string | undefined): string {
  if (requested) return requested
  const pendingAssemble = view.moves.find((m) => m.kind === 'assemble' && m.status === 'pending')
  if (pendingAssemble) return pendingAssemble.carIds[0]
  const any = view.moves.find((m) => m.status === 'pending')
  if (any) return any.carIds[0]
  throw new Error('No car in the plan to hold')
}
