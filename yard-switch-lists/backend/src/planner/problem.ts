/**
 * Turns a yard snapshot (and optionally the previous plan) into what the search
 * works on: cuts to classify, groups of cars to assign to trains, and the moves
 * it may not touch.
 *
 * Three tiers of "may not touch":
 *  - frozen: done or in progress. Facts. Carried verbatim, even from a replan
 *    that ignores the old plan.
 *  - horizon: pending moves due inside the frozen horizon. Crews have been told;
 *    kept unless a new fact makes them impossible, and then reported.
 *  - locked: a yardmaster said so. Kept whatever the cost, or surfaced as a
 *    conflict. Never quietly dropped.
 * @module planner/problem
 */
import { MIN, moveDurationMin } from '../domain/params.js'
import type {
  BlockDef,
  CarState,
  Consequence,
  InboundDef,
  LockDef,
  OutboundDef,
  PlanMove,
  TrackDef,
  YardRules,
  YardSnapshot,
} from '../domain/types.js'

export interface Cut {
  key: string
  groupKey: string
  inboundId: string
  blockId: string
  cars: CarState[]
  /** The track is not a decision: a lock, or a move inside the frozen horizon. */
  fixedTrack: string | null
  /** Must stay in baseline order at the front of the hump crew's work. */
  pinned: boolean
  lockId: string | null
}

export interface TrainGroup {
  key: string
  blockId: string
  cars: CarState[]
  earliest: number
  eligibleTrains: string[]
  /** Eligible trains the group can actually reach in time, judged from its ETA. */
  reachable: string[]
}

export interface FixedAssemble {
  move: PlanMove
  lockId: string | null
  pinned: boolean
}

export interface Problem {
  snap: YardSnapshot
  rules: YardRules
  now: number
  tracks: Record<string, TrackDef>
  blocks: Record<string, BlockDef>
  cars: Record<string, CarState>
  trains: OutboundDef[]
  trainById: Record<string, OutboundDef>
  servedBy: Record<string, string[]>
  cuts: Cut[]
  groups: TrainGroup[]
  receives: InboundDef[]
  frozen: PlanMove[]
  frozenKeys: Set<string>
  /** Keys with an execution record, even a cancelled one. A new move may not reuse them. */
  usedKeys: Set<string>
  departureTrackIds: string[]
  receivingTrackIds: string[]
  fixedAssemble: FixedAssemble[]
  pinnedTrim: string[]
  precedence: [string, string][]
  coupled: Record<string, CarState[]>
  setouts: CarState[]
  initialFt: Record<string, number>
  initialBlocks: Record<string, Record<string, number>>
  /** Footage the plan will free without planning anything: in-progress moves finishing. */
  initialReleases: { t: number; track: string; ft: number; blockId: string | null; count: number }[]
  carReadyAt: Record<string, number>
  carTrackAt: Record<string, string>
  inboundReady: Record<string, number>
  crewFree: { hump: number; trim: number }
  baseline: PlanMove[] | null
  /** Only a stable replan pays for changes. A from-scratch replan never looks at the old plan. */
  stable: boolean
  carEarliest: Record<string, number>
  carArrival: Record<string, number>
  inboundCars: Record<string, CarState[]>
  preConsequences: Consequence[]
  preUnassigned: { carId: string; reason: string }[]
  activeLocks: LockDef[]
  /** Car ids the plan will never touch this solve, with why. */
  unplannable: Record<string, string>
}

export interface BuildOptions {
  baseline?: PlanMove[] | null
  stable?: boolean
}

const groupKeyOf = (inboundId: string, blockId: string) => `${inboundId}:${blockId}`

export function buildProblem(snap: YardSnapshot, options: BuildOptions = {}): Problem {
  const stable = Boolean(options.stable && options.baseline)
  const baseline = options.baseline ?? null
  const rules = snap.rules
  const now = snap.now
  const tracks = Object.fromEntries(snap.tracks.map((t) => [t.id, t]))
  const blocks = Object.fromEntries(snap.blocks.map((b) => [b.id, b]))
  const cars = Object.fromEntries(snap.cars.map((c) => [c.id, c]))
  const trains = snap.outbound.filter((t) => t.status === 'planned' && t.departure > now).sort((a, b) => a.departure - b.departure || a.id.localeCompare(b.id))
  const trainById = Object.fromEntries(trains.map((t) => [t.id, t]))
  const servedBy: Record<string, string[]> = {}
  for (const t of trains) for (const b of t.blockSequence) (servedBy[b] ??= []).push(t.id)
  const inboundById = Object.fromEntries(snap.inbound.map((i) => [i.id, i]))

  const preConsequences: Consequence[] = []
  const preUnassigned: { carId: string; reason: string }[] = []
  const unplannable: Record<string, string> = {}

  // Facts: what's done and what's moving.
  const frozen: PlanMove[] = []
  const frozenKeys = new Set<string>()
  const execs = Object.values(snap.executions)
    .filter((e) => (e.status === 'done' || e.status === 'in_progress') && e.move)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.key.localeCompare(b.key))
  const inFlight = new Map<string, PlanMove>()
  const crewFree = { hump: now, trim: now }
  const initialReleases: Problem['initialReleases'] = []
  for (const e of execs) {
    const move = e.move as PlanMove
    frozen.push(move)
    frozenKeys.add(move.key)
    if (e.status === 'in_progress') {
      for (const id of move.carIds) inFlight.set(id, move)
      const end = Math.max(move.plannedEnd, now + MIN)
      if (move.crew === 'hump') crewFree.hump = Math.max(crewFree.hump, end)
      if (move.crew === 'trim') crewFree.trim = Math.max(crewFree.trim, end)
    }
  }

  // Physical state: footage and which block sits on which class track.
  const initialFt: Record<string, number> = {}
  const initialBlocks: Record<string, Record<string, number>> = {}
  for (const t of snap.tracks) {
    initialFt[t.id] = 0
    initialBlocks[t.id] = {}
  }
  const coupled: Record<string, CarState[]> = {}
  const setouts: CarState[] = []
  const carReadyAt: Record<string, number> = {}
  const carTrackAt: Record<string, string> = {}
  const carEarliest: Record<string, number> = {}
  const inboundReady: Record<string, number> = {}

  const receives: InboundDef[] = []
  for (const i of snap.inbound) {
    if (i.actualArrival !== null) inboundReady[i.id] = Math.max(now, i.actualArrival + (rules.inspectMin * MIN))
    else if (snap.cars.some((c) => c.inboundId === i.id && c.position === 'inbound')) {
      receives.push(i)
      inboundReady[i.id] = Infinity
    }
  }
  receives.sort((a, b) => a.eta - b.eta || a.id.localeCompare(b.id))

  const needClass: CarState[] = []
  const onClass: CarState[] = []
  for (const c of snap.cars) {
    if (c.position === 'departed') continue
    if (c.position === 'unknown') {
      unplannable[c.id] = 'location unknown after a crew report'
      continue
    }
    if (c.position === 'on_track' && c.trackId) {
      initialFt[c.trackId] = (initialFt[c.trackId] ?? 0) + c.lengthFt
      if (tracks[c.trackId]?.kind === 'classification') {
        const counts = initialBlocks[c.trackId]
        counts[c.blockId] = (counts[c.blockId] ?? 0) + 1
      }
      carTrackAt[c.id] = c.trackId
    }
    if (c.coupledTo) {
      if (inFlight.get(c.id)?.kind === 'setout') continue // Already coming off.
      // Includes a train past its departure time: it's waiting on this car to come off.
      if (c.held && snap.outbound.some((t) => t.id === c.coupledTo && t.status === 'planned')) setouts.push(c)
      else (coupled[c.coupledTo] ??= []).push(c)
      continue
    }
    if (c.held) {
      unplannable[c.id] = 'on hold'
      continue
    }
    if (c.position === 'on_track' && c.trackId && !tracks[c.trackId]?.open) {
      unplannable[c.id] = `standing on blocked track ${c.trackId}`
      continue
    }
    if (c.position === 'on_track' && c.trackId && tracks[c.trackId]?.kind === 'departure') {
      unplannable[c.id] = `standing on ${c.trackId} without a train`
      continue
    }
    const moving = inFlight.get(c.id)
    if (moving) continue
    if (c.position === 'inbound' || tracks[c.trackId as string]?.kind === 'receiving') needClass.push(c)
    else onClass.push(c)
  }
  for (const list of Object.values(coupled)) list.sort((a, b) => (a.coupledSeq ?? 0) - (b.coupledSeq ?? 0))

  // In-progress moves: reserve the destination now, free the source when they finish.
  for (const e of execs) {
    if (e.status !== 'in_progress') continue
    const move = e.move as PlanMove
    const end = Math.max(move.plannedEnd, now + MIN)
    for (const id of move.carIds) {
      const car = cars[id]
      if (!car) continue
      initialFt[move.toTrackId] = (initialFt[move.toTrackId] ?? 0) + car.lengthFt
      if (tracks[move.toTrackId]?.kind === 'classification') {
        initialBlocks[move.toTrackId][car.blockId] = (initialBlocks[move.toTrackId][car.blockId] ?? 0) + 1
      }
      if (move.fromTrackId) initialReleases.push({ t: end, track: move.fromTrackId, ft: car.lengthFt, blockId: car.blockId, count: 1 })
      carReadyAt[id] = end
      carTrackAt[id] = move.toTrackId
      if (move.kind === 'assemble' && move.outboundId) {
        if (!car.held) (coupled[move.outboundId] ??= []).push(car)
      } else if (!car.held) {
        if (tracks[move.toTrackId]?.open) onClass.push(car)
        else unplannable[car.id] = `landing on blocked track ${move.toTrackId}`
      }
    }
  }

  // Earliest a car could be classified by, used for feasibility filters and bounds.
  const hump = (n: number) => moveDurationMin(rules, 'classify', n) * MIN
  for (const c of needClass) {
    const i = c.inboundId ? inboundById[c.inboundId] : null
    const base = i && i.actualArrival === null ? Math.max(now, i.eta) + (rules.receiveMin + rules.inspectMin) * MIN : (c.inboundId ? inboundReady[c.inboundId] ?? now : now)
    carEarliest[c.id] = base + hump(1)
  }
  for (const c of onClass) {
    carReadyAt[c.id] ??= now
    carEarliest[c.id] = Math.max(now, carReadyAt[c.id])
  }

  // Locks.
  const activeLocks = snap.locks
  const lockedMove = new Map<string, LockDef>()
  const carTrackLock = new Map<string, LockDef>()
  const precedence: [string, string][] = []
  for (const l of activeLocks) {
    if (l.kind === 'move' && l.moveKey && l.move) lockedMove.set(l.moveKey, l)
    if (l.kind === 'car_track' && l.carId && l.trackId) carTrackLock.set(l.carId, l)
    if (l.kind === 'sequence' && l.moveKey && l.beforeKey) precedence.push([l.moveKey, l.beforeKey])
  }

  // Which pending baseline moves stay as they are.
  const inFixedClassify = new Set<string>()
  const inFixedAssemble = new Set<string>()
  const cuts: Cut[] = []
  const fixedAssemble: FixedAssemble[] = []
  const pinnedTrim: string[] = []
  const needClassSet = new Set(needClass.map((c) => c.id))
  const onClassSet = new Set(onClass.map((c) => c.id))
  const horizonEnd = now + rules.frozenHorizonMin * MIN

  const consider = (m: PlanMove, lock: LockDef | null, pinned: boolean) => {
    if (frozenKeys.has(m.key)) return
    if (m.kind !== 'classify' && m.kind !== 'assemble') return
    const eligible = m.carIds.filter((id) => (m.kind === 'classify' ? needClassSet.has(id) : needClassSet.has(id) || onClassSet.has(id)) && !inFixedAssemble.has(id))
    const dropped = m.carIds.filter((id) => !eligible.includes(id))
    if (!lock && pinned && dropped.length > 0) {
      const why = dropped.map((id) => (cars[id]?.held ? 'hold' : unplannable[id] ?? 'state changed'))[0]
      preConsequences.push({
        kind: 'frozen_move_changed',
        moveKey: m.key,
        carIds: dropped,
        reason: why,
        message: `Move ${m.key} was inside the frozen horizon but ${dropped.length} of its cars can't go (${why})`,
      })
    }
    if (eligible.length === 0) return
    if (!tracks[m.toTrackId]?.open) {
      if (!lock && pinned) {
        preConsequences.push({ kind: 'frozen_move_changed', moveKey: m.key, reason: 'track blocked', message: `Move ${m.key} was inside the frozen horizon but ${m.toTrackId} is now blocked` })
      }
      return
    }
    if (m.kind === 'classify') {
      const inbound = m.inboundId ? inboundById[m.inboundId] : null
      if (pinned && !lock && inbound && inbound.actualArrival === null && inbound.eta + (rules.receiveMin + rules.inspectMin) * MIN > horizonEnd) {
        preConsequences.push({
          kind: 'frozen_move_changed',
          moveKey: m.key,
          reason: 'train slipped',
          message: `Move ${m.key} was inside the frozen horizon but ${inbound.symbol} no longer arrives in time`,
        })
        return
      }
      const group = eligible.map((id) => cars[id])
      for (const id of eligible) inFixedClassify.add(id)
      cuts.push({
        key: m.key,
        groupKey: groupKeyOf(m.inboundId ?? 'yard', m.blockId ?? group[0].blockId),
        inboundId: m.inboundId ?? group[0].inboundId ?? 'yard',
        blockId: m.blockId ?? group[0].blockId,
        cars: group,
        fixedTrack: m.toTrackId,
        pinned,
        lockId: lock?.id ?? null,
      })
    } else {
      if (!m.outboundId || !trainById[m.outboundId]) return
      for (const id of eligible) inFixedAssemble.add(id)
      fixedAssemble.push({ move: { ...m, carIds: eligible }, lockId: lock?.id ?? null, pinned })
      if (pinned) pinnedTrim.push(m.key)
    }
  }

  if (baseline && stable) {
    for (const m of baseline) {
      const lock = lockedMove.get(m.key) ?? null
      const inHorizon = m.plannedStart <= horizonEnd
      if (lock) continue // handled below, from the lock's own copy of the move
      if (inHorizon) consider(m, null, true)
    }
  }
  // Locked moves are honoured with or without a baseline: a from-scratch replan still respects a yardmaster's lock.
  for (const l of activeLocks) {
    if (l.kind === 'move' && l.move && !frozenKeys.has(l.move.key)) consider(l.move, l, false)
  }

  // Remaining cars become cuts, split by any car-to-track lock.
  const cutCars = new Map<string, { inboundId: string; blockId: string; track: string | null; lockId: string | null; cars: CarState[] }>()
  for (const c of needClass) {
    if (inFixedClassify.has(c.id)) continue
    const lock = carTrackLock.get(c.id)
    const inboundId = c.inboundId ?? 'yard'
    const k = lock ? `${inboundId}:${c.blockId}:L${lock.trackId}` : `${inboundId}:${c.blockId}`
    if (!cutCars.has(k)) cutCars.set(k, { inboundId, blockId: c.blockId, track: lock?.trackId ?? null, lockId: lock?.id ?? null, cars: [] })
    cutCars.get(k)!.cars.push(c)
  }
  const usedKeys = new Set(Object.keys(snap.executions))
  const fixedCutKeys = new Set([...cuts.map((c) => c.key), ...usedKeys])
  for (const [k, v] of [...cutCars.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let key = `classify:${k}`
    let n = 2
    while (fixedCutKeys.has(key)) key = `classify:${k}#${n++}`
    fixedCutKeys.add(key)
    v.cars.sort((a, b) => a.consistPos - b.consistPos)
    cuts.push({ key, groupKey: groupKeyOf(v.inboundId, v.blockId), inboundId: v.inboundId, blockId: v.blockId, cars: v.cars, fixedTrack: v.track, pinned: false, lockId: v.lockId })
  }

  // Train-assignment groups: one decision per (inbound, block) or (class track, block).
  const groupMap = new Map<string, TrainGroup>()
  const addToGroup = (key: string, c: CarState) => {
    if (inFixedAssemble.has(c.id)) return
    let g = groupMap.get(key)
    if (!g) {
      g = { key, blockId: c.blockId, cars: [], earliest: 0, eligibleTrains: [], reachable: [] }
      groupMap.set(key, g)
    }
    g.cars.push(c)
    g.earliest = Math.max(g.earliest, carEarliest[c.id] ?? now)
  }
  for (const c of needClass) addToGroup(groupKeyOf(c.inboundId ?? 'yard', c.blockId), c)
  for (const c of onClass) addToGroup(`T:${carTrackAt[c.id] ?? c.trackId}:${c.blockId}`, c)
  const groups = [...groupMap.values()].sort((a, b) => a.key.localeCompare(b.key))
  const lastChance = (moveDurationMin(rules, 'assemble', 1) + rules.brakeTestMin) * MIN
  for (const g of groups) {
    g.eligibleTrains = servedBy[g.blockId] ?? []
    g.reachable = g.eligibleTrains.filter((id) => g.earliest + lastChance <= trainById[id].departure)
  }

  const carArrival: Record<string, number> = {}
  const inboundCars: Record<string, CarState[]> = {}
  for (const c of snap.cars) {
    const i = c.inboundId ? inboundById[c.inboundId] : null
    carArrival[c.id] = c.arrivedAt ?? i?.eta ?? now
    if (c.inboundId && c.position === 'inbound') (inboundCars[c.inboundId] ??= []).push(c)
  }

  for (const c of snap.cars) {
    if (unplannable[c.id] && !c.held) preUnassigned.push({ carId: c.id, reason: unplannable[c.id] })
  }

  return {
    snap,
    rules,
    now,
    tracks,
    blocks,
    cars,
    trains,
    trainById,
    servedBy,
    cuts,
    groups,
    receives,
    frozen,
    frozenKeys,
    usedKeys,
    departureTrackIds: snap.tracks.filter((t) => t.kind === 'departure').map((t) => t.id),
    receivingTrackIds: snap.tracks.filter((t) => t.kind === 'receiving' && t.open).map((t) => t.id),
    fixedAssemble,
    pinnedTrim,
    precedence,
    coupled,
    setouts,
    initialFt,
    initialBlocks,
    initialReleases,
    carReadyAt,
    carTrackAt,
    inboundReady,
    crewFree,
    baseline,
    stable,
    carEarliest,
    carArrival,
    inboundCars,
    preConsequences,
    preUnassigned,
    activeLocks,
    unplannable,
  }
}
