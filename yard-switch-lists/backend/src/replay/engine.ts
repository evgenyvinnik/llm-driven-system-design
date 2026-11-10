/**
 * The replay: the same seeded shift run start to finish under different policies,
 * in memory, on simulated time. Crew speed, late trains, holds and blocked tracks
 * all come from (seed, label), so they're identical across policies. Only the
 * decisions differ, which is what makes the comparison mean anything.
 *
 * Policies:
 *  - planner: local search with stable replanning.
 *  - planner_overrides: the same, plus a scripted yardmaster who sometimes
 *    protects a tight train, sometimes follows a habit, and hears about a late
 *    train on the radio an hour before dispatch updates the ETA.
 *  - baseline: earliest-deadline-first with no search, re-derived from scratch
 *    at each trigger. Roughly a good rule of thumb.
 *
 * Limits worth saying out loud: the scripted yardmaster is an assumption, not a
 * person. A real comparison has selection effects (people override when the plan
 * already looks wrong, so overridden shifts are harder shifts), and a simulator
 * only rewards what it models. This tells you how the logic behaves, not that the
 * planner beats a yardmaster in a real yard.
 * @module replay/engine
 */
import { createHash } from 'node:crypto'
import { MIN, moveDurationMin } from '../domain/params.js'
import { SHIFT_HOURS, initialSnapshot } from '../domain/scenario.js'
import { countDisturbed } from '../domain/diff.js'
import { applyOps } from '../domain/edit-ops.js'
import type { LockDef, PlanMove, YardSnapshot } from '../domain/types.js'
import { draw, hash32 } from '../shared/rng.js'
import { solve } from '../planner/solve.js'
import { retime, validatePlan } from '../validator/validate.js'

export type Policy = 'planner' | 'planner_overrides' | 'baseline'
export const POLICIES: Policy[] = ['planner', 'planner_overrides', 'baseline']

export interface ReplayEvent {
  kind: 'override' | 'capacity' | 'replan'
  at: number
  code: string
  value: number
  detail: string
}

export interface ReplayOutcome {
  seed: number
  policy: Policy
  departures: { outboundId: string; symbol: string; scheduled: number; actual: number | null; cars: number; status: string; onTime: boolean }[]
  cars: { carId: string; arrivedAt: number | null; departedAt: number | null; handlings: number }[]
  events: ReplayEvent[]
  metrics: ReplayMetrics
  digest: string
}

export interface ReplayMetrics {
  trains: number
  onTime: number
  onTimePct: number
  missed: number
  carsDeparted: number
  carsStranded: number
  movesPerCar: number
  avgDwellHours: number
  capacityViolations: number
  overrides: number
  overrideRatePer100Moves: number
  overrideReasons: Record<string, number>
  replans: number
  disturbedMoves: number
  invalidPlans: number
  totalMoves: number
}

const ON_TIME_TOLERANCE = 15 * MIN

export interface Disruptions {
  slip: { inboundId: string; slipMin: number; revealAt: number }
  hold: { carId: string; placeAt: number; releaseAt: number }
  block: { trackId: string; at: number; until: number }
}

/** Same for every policy with this seed. */
export function disruptionsFor(seed: number, snap: YardSnapshot): Disruptions {
  const inbound = [...snap.inbound].sort((a, b) => a.eta - b.eta)
  const late = inbound[1 + Math.floor(draw(seed, 'slip') * 2)]
  const start = snap.now
  const cars = snap.cars.filter((c) => c.inboundId === inbound[0].id)
  const held = cars[Math.floor(draw(seed, 'holdcar') * cars.length)]
  const classTracks = snap.tracks.filter((t) => t.kind === 'classification' && t.id !== 'C9' && t.id !== 'C10')
  const track = classTracks[Math.floor(draw(seed, 'block') * classTracks.length)]
  return {
    slip: { inboundId: late.id, slipMin: 180, revealAt: Math.max(start + 30 * MIN, late.eta - 60 * MIN) },
    hold: { carId: held.id, placeAt: start + Math.round((1 + draw(seed, 'holdat') * 2) * 60) * MIN, releaseAt: start + Math.round((5 + draw(seed, 'holdrel') * 2) * 60) * MIN },
    block: { trackId: track.id, at: start + Math.round((2 + draw(seed, 'blockat') * 3) * 60) * MIN, until: start + Math.round((6 + draw(seed, 'blockend') * 2) * 60) * MIN },
  }
}

export function crewFactor(seed: number, key: string): number {
  return 0.95 + draw(seed, `dur|${key}`) * 0.35
}

interface Options {
  iterations: number
  stepMin?: number
}

export async function runPolicy(seed: number, policy: Policy, options: Options): Promise<ReplayOutcome> {
  const snap = initialSnapshot(seed)
  const start = snap.now
  const end = start + SHIFT_HOURS * 60 * MIN
  const step = (options.stepMin ?? 2) * MIN
  const disruptions = disruptionsFor(seed, snap)
  const events: ReplayEvent[] = []
  const handlings: Record<string, number> = {}
  const carOf = new Map(snap.cars.map((c) => [c.id, c]))
  const trackOf = new Map(snap.tracks.map((t) => [t.id, t]))
  const actualArrival: Record<string, number> = {}
  for (const i of snap.inbound) actualArrival[i.id] = i.scheduledArrival + Math.round((draw(seed, `arr|${i.id}`) - 0.3) * 20) * MIN
  actualArrival[disruptions.slip.inboundId] += disruptions.slip.slipMin * MIN
  const departures: ReplayOutcome['departures'] = []
  let head: PlanMove[] = []
  let replans = 0
  let disturbed = 0
  let invalidPlans = 0
  let solveSeq = 0
  let overrideSeq = 0
  const crew: Record<'hump' | 'trim', { key: string; finishAt: number; move: PlanMove } | null> = { hump: null, trim: null }
  const done = new Set<string>()

  const plan = async (first: boolean) => {
    solveSeq++
    const seedForSolve = hash32(`replay|${seed}|${policy}|${solveSeq}`) % 2_000_000_000
    const useSearch = policy !== 'baseline'
    const stable = useSearch && !first
    const result = await solve(snap, {
      algorithm: useSearch ? 'local_search' : 'greedy',
      timeLimitMs: 60_000,
      iterationLimit: options.iterations,
      seed: seedForSolve,
      baseline: first ? null : head,
      stable,
    })
    const validation = validatePlan(snap, result.moves)
    const usable = validation.ok && result.conflicts.length === 0
    if (!first) {
      replans++
      const change = countDisturbed(head, result.moves, result.problem.frozenKeys)
      if (usable) disturbed += change.disturbed
      events.push({ kind: 'replan', at: snap.now, code: usable ? 'ok' : 'invalid', value: change.disturbed, detail: `v${solveSeq}` })
    }
    if (!usable) {
      invalidPlans++
      if (process.env.REPLAY_DEBUG) console.log('INVALID', seed, policy, new Date(snap.now).toISOString().slice(11,16), validation.violations.slice(0,4).map((v) => v.code + ' ' + v.message), result.conflicts.map((c) => c.code + ' ' + c.message))
      return
    }
    head = result.moves
    if (policy === 'planner_overrides') scriptedOverrides(result.moves)
  }

  const scriptedOverrides = (moves: PlanMove[]) => {
    overrideSeq++
    const pendingHump = moves.filter((m) => m.crew === 'hump' && !snap.executions[m.key])
    const tryOp = (moveKey: string, toIndex: number, code: string) => {
      const { moves: edited, moved, pins } = applyOps(head, [{ op: 'reorder', moveKey, toIndex }])
      const timed = retime(snap, edited, moved)
      const check = validatePlan(snap, timed)
      if (!check.ok) return false
      head = timed
      for (const pin of pins) {
        const lock: LockDef = { id: `pin${overrideSeq}-${snap.locks.length}`, kind: 'sequence', moveKey: pin.before, beforeKey: pin.after, carId: null, trackId: null, move: null, by: 'yardmaster', reason: code }
        snap.locks.push(lock)
      }
      events.push({ kind: 'override', at: snap.now, code, value: 1, detail: moveKey })
      return true
    }
    // Protect the tightest train: bring its last feeder forward.
    const check = validatePlan(snap, head)
    const tight = check.readiness.filter((r) => r.status === 'ready' && r.slackMin !== null && r.slackMin < 25 && r.departure > snap.now).sort((a, b) => (a.slackMin ?? 0) - (b.slackMin ?? 0))[0]
    if (tight) {
      const cars = new Set(head.filter((m) => m.outboundId === tight.outboundId && m.kind === 'assemble').flatMap((m) => m.carIds))
      const feeder = [...pendingHump].reverse().find((m) => m.carIds.some((id) => cars.has(id)))
      if (feeder) {
        const at = head.findIndex((m) => m.key === feeder.key)
        const firstPending = head.findIndex((m) => !snap.executions[m.key])
        if (at > firstPending) tryOp(feeder.key, Math.max(firstPending, at - 2), 'protect_departure')
      }
    }
    // Habit: an experienced yardmaster's preference, which may or may not help.
    if (pendingHump.length >= 2 && draw(seed, `habit|${overrideSeq}`) < 0.3) {
      const pick = Math.floor(draw(seed, `habitpick|${overrideSeq}`) * (pendingHump.length - 1))
      const at = head.findIndex((m) => m.key === pendingHump[pick + 1].key)
      const firstPending = head.findIndex((m) => !snap.executions[m.key])
      if (at > firstPending) tryOp(pendingHump[pick + 1].key, at - 1, 'crew_preference')
    }
  }

  const footage = (trackId: string): number => {
    let ft = 0
    for (const c of snap.cars) if (c.position === 'on_track' && c.trackId === trackId) ft += c.lengthFt
    return ft
  }

  const completeMove = (m: PlanMove, at: number) => {
    const to = trackOf.get(m.toTrackId)
    for (let i = 0; i < m.carIds.length; i++) {
      const car = carOf.get(m.carIds[i])
      if (!car || car.position === 'departed' || car.position === 'unknown') continue
      car.trackId = m.toTrackId
      car.position = 'on_track'
      if (to?.kind === 'departure') {
        car.coupledTo = m.outboundId
        car.coupledSeq = at * 1000 + i
      } else {
        car.coupledTo = null
        car.coupledSeq = null
      }
      handlings[car.id] = (handlings[car.id] ?? 0) + 1
    }
    snap.executions[m.key] = { key: m.key, status: 'done', startedAt: snap.executions[m.key]?.startedAt ?? at, completedAt: at, move: m }
    done.add(m.key)
    if (to) {
      const ft = footage(to.id)
      if (ft > to.capacityFt) events.push({ kind: 'capacity', at, code: to.id, value: ft - to.capacityFt, detail: m.key })
    }
  }

  await plan(true)
  const revealed = { slip: false, radio: false, hold: false, release: false, block: false, unblock: false }
  const holdCar = carOf.get(disruptions.hold.carId)
  for (let t = start; t <= end; t += step) {
    snap.now = t
    let trigger = false

    // Crews finishing.
    for (const name of ['hump', 'trim'] as const) {
      const c = crew[name]
      if (c && c.finishAt <= t) {
        completeMove(c.move, c.finishAt)
        crew[name] = null
        if (c.finishAt - c.move.plannedEnd > 25 * MIN) trigger = true
      }
    }

    // Disruptions, same for all policies. The radio is the yardmaster's private information.
    if (policy === 'planner_overrides' && !revealed.radio && t >= disruptions.slip.revealAt - 60 * MIN) {
      revealed.radio = true
      revealed.slip = true
      const i = snap.inbound.find((x) => x.id === disruptions.slip.inboundId)
      if (i && i.actualArrival === null) {
        i.eta = i.scheduledArrival + disruptions.slip.slipMin * MIN
        events.push({ kind: 'override', at: t, code: 'radio_information', value: 1, detail: i.id })
        trigger = true
      }
    }
    if (!revealed.slip && t >= disruptions.slip.revealAt) {
      revealed.slip = true
      const i = snap.inbound.find((x) => x.id === disruptions.slip.inboundId)
      if (i && i.actualArrival === null) {
        i.eta = i.scheduledArrival + disruptions.slip.slipMin * MIN
        trigger = true
      }
    }
    if (!revealed.hold && t >= disruptions.hold.placeAt && holdCar) {
      revealed.hold = true
      if (holdCar.position !== 'departed') {
        holdCar.held = true
        trigger = true
      }
    }
    if (!revealed.release && t >= disruptions.hold.releaseAt && holdCar) {
      revealed.release = true
      if (holdCar.held) {
        holdCar.held = false
        trigger = true
      }
    }
    const blocked = trackOf.get(disruptions.block.trackId)
    if (!revealed.block && t >= disruptions.block.at && blocked) {
      revealed.block = true
      blocked.open = false
      trigger = true
    }
    if (!revealed.unblock && t >= disruptions.block.until && blocked) {
      revealed.unblock = true
      blocked.open = true
      trigger = true
    }

    // Arrivals.
    for (const i of snap.inbound) {
      if (i.actualArrival !== null || actualArrival[i.id] > t) continue
      const planned = head.find((m) => m.key === `receive:${i.id}`)
      const cars = snap.cars.filter((c) => c.inboundId === i.id && c.position === 'inbound')
      const length = cars.reduce((s, c) => s + c.lengthFt, 0)
      const receiving = snap.tracks.filter((x) => x.kind === 'receiving' && x.open)
      const chosen =
        (planned && trackOf.get(planned.toTrackId)?.open && footage(planned.toTrackId) + length <= (trackOf.get(planned.toTrackId)?.capacityFt ?? 0) ? planned.toTrackId : null) ??
        receiving.find((x) => footage(x.id) + length <= x.capacityFt)?.id ??
        null
      if (!chosen) continue // The train waits outside the yard until a track clears.
      i.actualArrival = t
      i.receivingTrackId = chosen
      for (const c of cars) {
        c.position = 'on_track'
        c.trackId = chosen
        c.arrivedAt = t
      }
      const move: PlanMove = { key: `receive:${i.id}`, kind: 'receive', crew: 'road', carIds: cars.map((c) => c.id), fromTrackId: null, toTrackId: chosen, blockId: null, inboundId: i.id, outboundId: null, plannedStart: t, plannedEnd: t + 15 * MIN }
      snap.executions[move.key] = { key: move.key, status: 'done', startedAt: t, completedAt: t, move }
      if (!planned || planned.toTrackId !== chosen || Math.abs(i.eta - t) > 15 * MIN) trigger = true
    }

    // Departures. A held car on a train makes the train wait.
    for (const train of snap.outbound) {
      if (train.status !== 'planned' || train.departure > t) continue
      const cars = snap.cars.filter((c) => c.coupledTo === train.id && c.position === 'on_track')
      if (cars.some((c) => c.held)) {
        trigger = trigger || !head.some((m) => m.kind === 'setout' && m.outboundId === train.id)
        continue
      }
      if (cars.length === 0) {
        train.status = 'missed'
        departures.push({ outboundId: train.id, symbol: train.symbol, scheduled: train.scheduledDeparture, actual: null, cars: 0, status: 'missed', onTime: false })
      } else {
        train.status = 'departed'
        for (const c of cars) {
          c.position = 'departed'
          c.trackId = null
          c.coupledTo = c.coupledTo ?? null
          ;(c as unknown as { departedAt: number }).departedAt = t
        }
        departures.push({ outboundId: train.id, symbol: train.symbol, scheduled: train.scheduledDeparture, actual: t, cars: cars.length, status: 'departed', onTime: t - train.scheduledDeparture <= ON_TIME_TOLERANCE })
      }
      for (const m of head) {
        if (m.outboundId === train.id && m.kind === 'assemble' && !snap.executions[m.key]) {
          snap.executions[m.key] = { key: m.key, status: 'cancelled', startedAt: null, completedAt: null, move: m }
          trigger = true
        }
      }
    }

    if (trigger) await plan(false)

    // Crews starting.
    for (const name of ['hump', 'trim'] as const) {
      if (crew[name]) continue
      // A crew won't couple a train's blocks out of sequence: an unready pull holds up that train's later pulls.
      const trainWaiting = new Set<string>()
      for (const m of head) {
        if (m.crew !== name) continue
        const exec = snap.executions[m.key]
        if (exec && exec.status !== 'pending') continue
        if (m.plannedStart > t) break
        const cars = m.carIds.map((id) => carOf.get(id))
        const ready = cars.every((c) => c && c.position === 'on_track' && c.trackId === m.fromTrackId)
        const heldCar = m.kind !== 'setout' && cars.some((c) => c?.held)
        const waiting = m.kind === 'assemble' && m.outboundId !== null && trainWaiting.has(m.outboundId)
        if (!ready || heldCar || waiting) {
          if (m.kind === 'assemble' && m.outboundId) trainWaiting.add(m.outboundId)
          continue
        }
        const dur = moveDurationMin(snap.rules, m.kind === 'receive' ? 'receive' : m.kind, m.carIds.length) * MIN * crewFactor(seed, m.key)
        const finishAt = t + Math.round(dur / MIN) * MIN
        crew[name] = { key: m.key, finishAt, move: m }
        snap.executions[m.key] = { key: m.key, status: 'in_progress', startedAt: t, completedAt: null, move: { ...m, plannedEnd: finishAt } }
        break
      }
    }
  }

  const carsOut = snap.cars.map((c) => ({
    carId: c.id,
    arrivedAt: c.arrivedAt,
    departedAt: c.position === 'departed' ? ((c as unknown as { departedAt?: number }).departedAt ?? null) : null,
    handlings: handlings[c.id] ?? 0,
  }))
  for (const train of snap.outbound) {
    if (train.status === 'planned') departures.push({ outboundId: train.id, symbol: train.symbol, scheduled: train.scheduledDeparture, actual: null, cars: 0, status: 'stuck', onTime: false })
  }
  const metrics = computeReplayMetrics(departures, carsOut, events, invalidPlans, replans, disturbed, head.length)
  const digest = createHash('sha256').update(JSON.stringify({ departures, carsOut, events })).digest('hex')
  return { seed, policy, departures, cars: carsOut, events, metrics, digest }
}

/** Metrics from the raw rows. The e2e recomputes these from the database independently. */
export function computeReplayMetrics(
  departures: ReplayOutcome['departures'],
  cars: ReplayOutcome['cars'],
  events: ReplayEvent[],
  invalidPlans: number,
  replans: number,
  disturbedMoves: number,
  totalMoves: number,
): ReplayMetrics {
  const onTime = departures.filter((d) => d.onTime).length
  const gone = cars.filter((c) => c.departedAt !== null)
  const handled = cars.filter((c) => c.handlings > 0)
  const handlings = cars.reduce((s, c) => s + c.handlings, 0)
  const dwell = gone.filter((c) => c.arrivedAt !== null).map((c) => ((c.departedAt as number) - (c.arrivedAt as number)) / 3_600_000)
  const overrides = events.filter((e) => e.kind === 'override')
  const overrideReasons: Record<string, number> = {}
  for (const o of overrides) overrideReasons[o.code] = (overrideReasons[o.code] ?? 0) + 1
  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d
  return {
    trains: departures.length,
    onTime,
    onTimePct: departures.length ? round((onTime / departures.length) * 100, 1) : 0,
    missed: departures.filter((d) => d.status !== 'departed').length,
    carsDeparted: gone.length,
    carsStranded: cars.filter((c) => c.arrivedAt !== null && c.departedAt === null).length,
    movesPerCar: handled.length ? round(handlings / handled.length) : 0,
    avgDwellHours: dwell.length ? round(dwell.reduce((a, b) => a + b, 0) / dwell.length) : 0,
    capacityViolations: events.filter((e) => e.kind === 'capacity').length,
    overrides: overrides.length,
    overrideRatePer100Moves: totalMoves ? round((overrides.length / totalMoves) * 100, 1) : 0,
    overrideReasons,
    replans,
    disturbedMoves,
    invalidPlans,
    totalMoves,
  }
}

export interface ReplaySummaryRow {
  policy: Policy
  shifts: number
  onTimePct: number
  missed: number
  carsDeparted: number
  carsStranded: number
  movesPerCar: number
  avgDwellHours: number
  capacityViolations: number
  overrides: number
  overrideReasons: Record<string, number>
  disturbedMoves: number
  invalidPlans: number
}

export function summarize(outcomes: ReplayOutcome[]): ReplaySummaryRow[] {
  return POLICIES.map((policy) => {
    const rows = outcomes.filter((o) => o.policy === policy)
    const departures = rows.flatMap((o) => o.departures)
    const cars = rows.flatMap((o) => o.cars)
    const m = computeReplayMetrics(departures, cars, rows.flatMap((o) => o.events), 0, 0, 0, rows.reduce((s, o) => s + o.metrics.totalMoves, 0))
    return {
      policy,
      shifts: rows.length,
      onTimePct: m.onTimePct,
      missed: m.missed,
      carsDeparted: m.carsDeparted,
      carsStranded: m.carsStranded,
      movesPerCar: m.movesPerCar,
      avgDwellHours: m.avgDwellHours,
      capacityViolations: m.capacityViolations,
      overrides: m.overrides,
      overrideReasons: m.overrideReasons,
      disturbedMoves: rows.reduce((s, o) => s + o.metrics.disturbedMoves, 0),
      invalidPlans: rows.reduce((s, o) => s + o.metrics.invalidPlans, 0),
    }
  })
}
