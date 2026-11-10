/**
 * The independent validator. It answers one question: could this ordered list
 * of moves really be carried out against this yard state without breaking a
 * rule? It works from the raw snapshot and the raw list, and it re-derives every
 * time itself. It imports nothing from the planner, on purpose: a bug in the
 * decoder can't hide here, and a person's edit gets the same checks as a plan.
 * A test fails the build if this folder ever imports planner code.
 *
 * Severities:
 *   safety    a car hold, hazmat placement, train tonnage. Never overridable.
 *   physical  can't be done: no room, cars aren't there, blocked track, mixed
 *             block, wrong order. Never overridable.
 *   operating standing order, departure time, train length. A yardmaster may
 *             knowingly change the underlying fact, with a recorded reason.
 *
 * Hazmat rules here are SIMPLIFIED FROM real position-in-train rules. They are
 * not the regulation.
 * @module validator/validate
 */
import type { PlanMove, TrainReadiness, ValidationResult, Violation, YardSnapshot } from '../domain/types.js'

const MINUTE = 60_000

function minutesFor(snapshot: YardSnapshot, m: PlanMove): number {
  const r = snapshot.rules
  const n = m.carIds.length
  switch (m.kind) {
    case 'receive':
      return r.receiveMin
    case 'classify':
      return r.classifyFixedMin + n * r.classifyPerCarMin
    case 'assemble':
      return r.assembleFixedMin + n * r.assemblePerCarMin
    default:
      return r.setoutMin
  }
}

interface Scheduled {
  move: PlanMove
  start: number
  end: number
  /** Already started: its landing is a fact to account for, not a choice to judge. */
  started: boolean
}

interface Replay {
  timeline: Record<string, { start: number; end: number }>
  scheduled: Scheduled[]
  violations: Violation[]
  consists: Record<string, string[]>
  depTrack: Record<string, string>
  readyAt: Record<string, number>
  coupledStart: Record<string, number>
  setoutCars: Set<string>
}

function replay(snapshot: YardSnapshot, moves: PlanMove[], clearNotBefore?: Set<string>): Replay {
  const violations: Violation[] = []
  const trackOf = new Map(snapshot.tracks.map((t) => [t.id, t]))
  const blockOf = new Map(snapshot.blocks.map((b) => [b.id, b]))
  const carOf = new Map(snapshot.cars.map((c) => [c.id, c]))
  const inboundOf = new Map(snapshot.inbound.map((i) => [i.id, i]))
  const trainOf = new Map(snapshot.outbound.map((t) => [t.id, t]))
  const now = snapshot.now
  const rules = snapshot.rules

  const where = new Map<string, string | null>()
  for (const c of snapshot.cars) where.set(c.id, c.position === 'on_track' ? c.trackId : null)
  const available = new Map<string, number>()
  const crewFree: Record<string, number> = { hump: now, trim: now, road: now }
  const inboundReceivedAt = new Map<string, number>()
  const seen = new Set<string>()
  const classified = new Set<string>()
  const coupledCars = new Set<string>()
  const consists: Record<string, string[]> = {}
  const depTrack: Record<string, string> = {}
  const readyAt: Record<string, number> = {}
  const coupledStart: Record<string, number> = {}
  const setoutCars = new Set(moves.filter((m) => m.kind === 'setout').flatMap((m) => m.carIds))

  for (const c of snapshot.cars) {
    if (c.coupledTo && !setoutCars.has(c.id)) (consists[c.coupledTo] ??= []).push(c.id)
    if (c.coupledTo && c.trackId) depTrack[c.coupledTo] = c.trackId
  }
  for (const list of Object.values(consists)) {
    list.sort((a, b) => (carOf.get(a)?.coupledSeq ?? 0) - (carOf.get(b)?.coupledSeq ?? 0))
  }

  const timeline: Replay['timeline'] = {}
  const scheduled: Scheduled[] = []
  let prevStart = now

  for (const m of moves) {
    if (seen.has(m.key)) {
      violations.push({ code: 'DUPLICATE_MOVE', severity: 'physical', moveKey: m.key, message: `Move ${m.key} appears twice` })
      continue
    }
    seen.add(m.key)
    const exec = snapshot.executions[m.key]
    if (exec && (exec.status === 'done' || exec.status === 'in_progress') && exec.move) {
      const frozen = exec.move
      const same =
        frozen.toTrackId === m.toTrackId &&
        frozen.fromTrackId === m.fromTrackId &&
        frozen.carIds.length === m.carIds.length &&
        frozen.carIds.every((id) => m.carIds.includes(id))
      if (!same) {
        violations.push({ code: 'FROZEN_CHANGED', severity: 'physical', moveKey: m.key, message: `Move ${m.key} has already ${exec.status === 'done' ? 'been done' : 'started'} and can't be changed` })
      }
    }
    if (exec?.status === 'done') {
      timeline[m.key] = { start: exec.startedAt ?? m.plannedStart, end: exec.completedAt ?? m.plannedEnd }
      if (m.kind === 'assemble') for (const id of m.carIds) coupledCars.add(id)
      if (m.kind === 'classify') for (const id of m.carIds) classified.add(id)
      if (m.kind === 'receive' && m.inboundId) inboundReceivedAt.set(m.inboundId, exec.completedAt ?? m.plannedEnd)
      continue
    }
    const to = trackOf.get(m.toTrackId)
    if (!to) {
      violations.push({ code: 'UNKNOWN_TRACK', severity: 'physical', moveKey: m.key, trackId: m.toTrackId, message: `Move ${m.key} targets unknown track ${m.toTrackId}` })
      continue
    }
    const inProgress = exec?.status === 'in_progress'
    if (!inProgress && !to.open) {
      violations.push({ code: 'TRACK_BLOCKED', severity: 'physical', moveKey: m.key, trackId: to.id, message: `${to.name} is blocked; move ${m.key} can't land there` })
    }
    const from = m.fromTrackId ? trackOf.get(m.fromTrackId) : null
    if (!inProgress && from && !from.open) {
      violations.push({ code: 'TRACK_BLOCKED', severity: 'physical', moveKey: m.key, trackId: from.id, message: `${from.name} is blocked; move ${m.key} can't pull from it` })
    }

    // When could this move start?
    let earliest = Math.max(prevStart, now)
    if (!clearNotBefore?.has(m.key)) earliest = Math.max(earliest, m.plannedStart)
    if (m.crew !== 'road') earliest = Math.max(earliest, crewFree[m.crew] ?? now)
    if (m.kind === 'receive' && m.inboundId) {
      const i = inboundOf.get(m.inboundId)
      if (i) earliest = Math.max(earliest, i.actualArrival ?? i.eta)
    }
    if (m.kind === 'classify' && m.inboundId) {
      const i = inboundOf.get(m.inboundId)
      if (i && i.actualArrival !== null) earliest = Math.max(earliest, i.actualArrival + rules.inspectMin * MINUTE)
      else if (inboundReceivedAt.has(m.inboundId)) earliest = Math.max(earliest, (inboundReceivedAt.get(m.inboundId) as number) + rules.inspectMin * MINUTE)
    }

    const carIds = m.carIds
    for (const id of carIds) {
      const car = carOf.get(id)
      if (!car) {
        violations.push({ code: 'UNKNOWN_CAR', severity: 'physical', moveKey: m.key, carIds: [id], message: `Move ${m.key} names unknown car ${id}` })
        continue
      }
      if (car.position === 'departed') {
        violations.push({ code: 'MOVE_PRECEDENCE', severity: 'physical', moveKey: m.key, carIds: [id], message: `${id} has already left on a train` })
        continue
      }
      if (car.position === 'unknown') {
        violations.push({ code: 'MOVE_PRECEDENCE', severity: 'physical', moveKey: m.key, carIds: [id], message: `${id}: a crew reported it isn't where expected, so it can't be planned until it's found` })
        continue
      }
      if (m.kind === 'receive') {
        if (car.position !== 'inbound' && !inProgress) violations.push({ code: 'MOVE_PRECEDENCE', severity: 'physical', moveKey: m.key, carIds: [id], message: `${id} has already arrived` })
      } else if ((where.get(id) ?? null) !== m.fromTrackId) {
        violations.push({
          code: 'MOVE_PRECEDENCE',
          severity: 'physical',
          moveKey: m.key,
          carIds: [id],
          message: `${id} won't be on ${m.fromTrackId ?? 'a track'} when move ${m.key} runs (it will be on ${where.get(id) ?? 'no track'})`,
        })
      }
      const ready = available.get(id)
      if (ready !== undefined) earliest = Math.max(earliest, ready)
      if ((m.kind === 'classify' || m.kind === 'assemble') && car.held && !inProgress) {
        violations.push({ code: 'CAR_HOLD', severity: 'safety', moveKey: m.key, carIds: [id], message: `${id} is on hold and can't be moved towards an outbound train` })
      }
    }

    if (m.kind === 'classify') {
      if (to.kind !== 'classification') violations.push({ code: 'WRONG_TRACK_KIND', severity: 'physical', moveKey: m.key, trackId: to.id, message: `A classify move must land on a classification track, not ${to.name}` })
      const block = m.blockId ? blockOf.get(m.blockId) : null
      if (block && to.id !== block.standingTrackId && !block.alternateTrackIds.includes(to.id)) {
        violations.push({
          code: 'STANDING_ORDER',
          severity: 'operating',
          moveKey: m.key,
          trackId: to.id,
          message: `Block ${block.id} has a standing order for ${block.standingTrackId} (alternates ${block.alternateTrackIds.join(', ') || 'none'}), not ${to.id}`,
        })
      }
      for (const id of carIds) {
        const car = carOf.get(id)
        if (car && m.blockId && car.blockId !== m.blockId) violations.push({ code: 'WRONG_BLOCK', severity: 'physical', moveKey: m.key, carIds: [id], message: `${id} belongs to block ${car.blockId}, not ${m.blockId}` })
      }
    }

    const start = inProgress ? (exec?.startedAt ?? now) : earliest
    const duration = minutesFor(snapshot, m) * MINUTE
    const end = inProgress ? Math.max(m.plannedEnd, now + MINUTE) : start + duration
    timeline[m.key] = { start, end }
    scheduled.push({ move: m, start, end, started: inProgress })
    if (!inProgress) prevStart = start
    if (m.crew !== 'road') crewFree[m.crew] = Math.max(crewFree[m.crew] ?? now, end)
    for (const id of carIds) {
      where.set(id, m.toTrackId)
      available.set(id, end)
      if (m.kind === 'classify') classified.add(id)
    }
    if (m.kind === 'receive' && m.inboundId) inboundReceivedAt.set(m.inboundId, end)

    if (m.kind === 'assemble') {
      const train = m.outboundId ? trainOf.get(m.outboundId) : undefined
      if (!train) {
        violations.push({ code: 'UNKNOWN_TRAIN', severity: 'physical', moveKey: m.key, message: `Move ${m.key} names an unknown outbound train` })
      } else {
        if (train.status !== 'planned' && !inProgress) violations.push({ code: 'TRAIN_GONE', severity: 'physical', moveKey: m.key, outboundId: train.id, message: `${train.symbol} has already ${train.status}` })
        if (to.kind !== 'departure') violations.push({ code: 'WRONG_TRACK_KIND', severity: 'physical', moveKey: m.key, trackId: to.id, message: `An assemble move must land on a departure track, not ${to.name}` })
        if (!inProgress && end + rules.brakeTestMin * MINUTE > train.departure) {
          violations.push({
            code: 'DEPARTURE_TIME',
            severity: 'operating',
            moveKey: m.key,
            outboundId: train.id,
            overBy: Math.round((end + rules.brakeTestMin * MINUTE - train.departure) / MINUTE),
            message: `${train.symbol}: move ${m.key} ends with a brake test finishing ${Math.round((end + rules.brakeTestMin * MINUTE - train.departure) / MINUTE)} min after departure`,
          })
        }
        for (const id of carIds) {
          const car = carOf.get(id)
          if (car && !train.blockSequence.includes(car.blockId)) {
            violations.push({ code: 'WRONG_BLOCK', severity: 'physical', moveKey: m.key, carIds: [id], message: `${id} (block ${car.blockId}) isn't in ${train.symbol}'s block sequence` })
          }
          ;(consists[train.id] ??= []).push(id)
        }
        if (depTrack[train.id] && depTrack[train.id] !== to.id) {
          violations.push({ code: 'TRAIN_SPLIT', severity: 'physical', moveKey: m.key, outboundId: train.id, message: `${train.symbol} can't be built on two departure tracks (${depTrack[train.id]} and ${to.id})` })
        }
        depTrack[train.id] = to.id
        coupledStart[train.id] = Math.min(coupledStart[train.id] ?? start, start)
        readyAt[train.id] = Math.max(readyAt[train.id] ?? 0, end + rules.brakeTestMin * MINUTE)
      }
    }
  }

  // Facts must stay in the plan: nobody gets to edit history away.
  for (const exec of Object.values(snapshot.executions)) {
    if ((exec.status === 'done' || exec.status === 'in_progress') && !seen.has(exec.key)) {
      violations.push({ code: 'FROZEN_CHANGED', severity: 'physical', moveKey: exec.key, message: `Move ${exec.key} has already ${exec.status === 'done' ? 'been done' : 'started'} but is missing from the plan` })
    }
  }

  return { timeline, scheduled, violations, consists, depTrack, readyAt, coupledStart, setoutCars }
}

function checkTracks(snapshot: YardSnapshot, r: Replay, violations: Violation[]): Record<string, number> {
  type Ev = { t: number; order: number; track: string; delta: number; carId: string; moveKey?: string; started?: boolean }
  const carOf = new Map(snapshot.cars.map((c) => [c.id, c]))
  const events: Ev[] = []
  const occupancy: Record<string, number> = {}
  const onTrack: Record<string, Map<string, number>> = {}
  const peak: Record<string, number> = {}
  for (const t of snapshot.tracks) {
    occupancy[t.id] = 0
    onTrack[t.id] = new Map()
    peak[t.id] = 0
  }
  const addCar = (track: string, block: string, delta: number) => {
    const m = onTrack[track]
    if (!m) return
    const next = (m.get(block) ?? 0) + delta
    if (next <= 0) m.delete(block)
    else m.set(block, next)
  }
  for (const c of snapshot.cars) {
    if (c.position === 'on_track' && c.trackId && occupancy[c.trackId] !== undefined) {
      occupancy[c.trackId] += c.lengthFt
      addCar(c.trackId, c.blockId, 1)
      peak[c.trackId] = Math.max(peak[c.trackId], occupancy[c.trackId])
    }
  }
  for (const s of r.scheduled) {
    for (const id of s.move.carIds) {
      const car = carOf.get(id)
      if (!car) continue
      events.push({ t: s.start, order: 1, track: s.move.toTrackId, delta: car.lengthFt, carId: id, moveKey: s.move.key, started: s.started })
      if (s.move.fromTrackId) events.push({ t: s.end, order: 0, track: s.move.fromTrackId, delta: -car.lengthFt, carId: id })
    }
  }
  // A train leaving frees its departure track.
  for (const train of snapshot.outbound) {
    const track = r.depTrack[train.id]
    if (!track) continue
    for (const id of r.consists[train.id] ?? []) {
      const car = carOf.get(id)
      if (car) events.push({ t: train.departure, order: 0, track, delta: -car.lengthFt, carId: id })
    }
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order)
  const trackOf = new Map(snapshot.tracks.map((t) => [t.id, t]))
  const flagged = new Set<string>()
  for (const e of events) {
    occupancy[e.track] = (occupancy[e.track] ?? 0) + e.delta
    const car = carOf.get(e.carId)
    if (car) addCar(e.track, car.blockId, e.delta > 0 ? 1 : -1)
    peak[e.track] = Math.max(peak[e.track] ?? 0, occupancy[e.track])
    const track = trackOf.get(e.track)
    if (!track || e.delta <= 0 || e.started) continue
    if (occupancy[e.track] > track.capacityFt && !flagged.has(`cap:${e.track}:${e.moveKey}`)) {
      flagged.add(`cap:${e.track}:${e.moveKey}`)
      violations.push({
        code: 'TRACK_CAPACITY',
        severity: 'physical',
        trackId: e.track,
        moveKey: e.moveKey,
        overBy: occupancy[e.track] - track.capacityFt,
        message: `${track.name} would hold ${occupancy[e.track]} ft against a capacity of ${track.capacityFt} ft when ${e.moveKey} lands`,
      })
    }
    if (track.kind === 'classification' && (onTrack[e.track]?.size ?? 0) > 1 && !flagged.has(`mix:${e.track}:${e.moveKey}`)) {
      flagged.add(`mix:${e.track}:${e.moveKey}`)
      violations.push({
        code: 'MIXED_BLOCK',
        severity: 'physical',
        trackId: e.track,
        moveKey: e.moveKey,
        message: `${track.name} would hold two blocks (${[...(onTrack[e.track]?.keys() ?? [])].join(', ')}) when ${e.moveKey} lands`,
      })
    }
  }
  return peak
}

function checkTrains(snapshot: YardSnapshot, r: Replay, moves: PlanMove[], violations: Violation[]): TrainReadiness[] {
  const rules = snapshot.rules
  const carOf = new Map(snapshot.cars.map((c) => [c.id, c]))
  const out: TrainReadiness[] = []
  const incompatible = (a: string, b: string) => rules.hazmatIncompatible.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
  for (const train of snapshot.outbound) {
    const consist = r.consists[train.id] ?? []
    let lengthFt = 0
    let tons = 0
    let cleanAhead = 0
    let firstHazmatSeen = false
    let lastBlockIndex = -1
    let lastHazmat: string | null = null
    let blocked = false
    // Cars already coupled are facts. A rule only fails the plan if the plan is still adding to the problem.
    const pendingOnTrain = consist.some((id) => carOf.get(id)?.coupledTo !== train.id)
    consist.forEach((id) => {
      const car = carOf.get(id)
      if (!car) return
      const isFact = car.coupledTo === train.id
      lengthFt += car.lengthFt
      tons += car.tons
      if (car.held) {
        blocked = true
        if (train.status === 'planned') {
          violations.push({ code: 'CAR_HOLD', severity: 'safety', carIds: [id], outboundId: train.id, message: `${id} is on hold and is coupled to ${train.symbol}; it must be set out before the train leaves` })
        }
      }
      if (car.hazmatClass) {
        if (!isFact && !firstHazmatSeen && cleanAhead < rules.hazmatBufferCars && train.status === 'planned') {
          violations.push({
            code: 'HAZMAT_BUFFER',
            severity: 'safety',
            carIds: [id],
            outboundId: train.id,
            message: `Placarded car ${id} is car ${cleanAhead + 1} behind the locomotive on ${train.symbol}; this yard's simplified rule needs ${rules.hazmatBufferCars} non-placarded cars ahead of it`,
          })
        }
        if (!isFact && lastHazmat && incompatible(lastHazmat, car.hazmatClass) && train.status === 'planned') {
          violations.push({ code: 'HAZMAT_ADJACENT', severity: 'safety', carIds: [id], outboundId: train.id, message: `Placarded ${id} (class ${car.hazmatClass}) sits next to an incompatible class ${lastHazmat} on ${train.symbol} (simplified rule)` })
        }
        firstHazmatSeen = true
        lastHazmat = car.hazmatClass
      } else {
        if (!firstHazmatSeen) cleanAhead++
        lastHazmat = null
      }
      const idx = train.blockSequence.indexOf(car.blockId)
      if (idx >= 0) {
        if (!isFact && idx < lastBlockIndex && train.status === 'planned') {
          violations.push({ code: 'BLOCK_SEQUENCE', severity: 'physical', carIds: [id], outboundId: train.id, message: `${train.symbol}: block ${car.blockId} is coupled after a later block in its sequence (${train.blockSequence.join(' → ')})` })
        }
        lastBlockIndex = Math.max(lastBlockIndex, idx)
      }
    })
    if (train.status === 'planned') {
      if (pendingOnTrain && lengthFt > train.maxLengthFt) {
        violations.push({ code: 'TRAIN_LENGTH', severity: 'operating', outboundId: train.id, overBy: lengthFt - train.maxLengthFt, message: `${train.symbol} is ${lengthFt} ft against a limit of ${train.maxLengthFt} ft` })
      }
      if (pendingOnTrain && tons > train.maxTons) {
        violations.push({ code: 'TRAIN_TONNAGE', severity: 'safety', outboundId: train.id, overBy: tons - train.maxTons, message: `${train.symbol} is ${tons} tons against a limit of ${train.maxTons} tons` })
      }
    }
    const readyAt = r.readyAt[train.id] ?? null
    const anyMove = moves.some((m) => m.outboundId === train.id && m.kind === 'assemble')
    let status: TrainReadiness['status']
    if (train.status === 'departed') status = 'departed'
    else if (train.status === 'missed') status = 'missed'
    else if (blocked) status = 'blocked'
    else if (!anyMove && consist.length === 0) status = 'annulled'
    else if (readyAt !== null && readyAt > train.departure) status = 'late'
    else if (consist.length < train.minCars) status = 'short'
    else status = 'ready'
    out.push({
      outboundId: train.id,
      symbol: train.symbol,
      departure: train.departure,
      scheduledDeparture: train.scheduledDeparture,
      cars: consist.length,
      lengthFt,
      tons,
      readyAt,
      slackMin: readyAt !== null ? Math.round((train.departure - readyAt) / MINUTE) : null,
      minCars: train.minCars,
      status,
    })
  }
  // Two trains can't share a departure track while both are standing on it.
  const trains = snapshot.outbound.filter((t) => t.status === 'planned' && r.depTrack[t.id])
  for (let i = 0; i < trains.length; i++) {
    for (let j = i + 1; j < trains.length; j++) {
      const a = trains[i]
      const b = trains[j]
      if (r.depTrack[a.id] !== r.depTrack[b.id]) continue
      const aStart = r.coupledStart[a.id] ?? snapshot.now
      const bStart = r.coupledStart[b.id] ?? snapshot.now
      if (aStart < b.departure && bStart < a.departure) {
        violations.push({ code: 'TRACK_CONFLICT', severity: 'physical', trackId: r.depTrack[a.id], outboundId: b.id, message: `${a.symbol} and ${b.symbol} would stand on ${r.depTrack[a.id]} at the same time` })
      }
    }
  }
  return out
}

function checkLocks(snapshot: YardSnapshot, moves: PlanMove[], violations: Violation[]) {
  const index = new Map(moves.map((m, i) => [m.key, i]))
  const carOf = new Map(snapshot.cars.map((c) => [c.id, c]))
  for (const lock of snapshot.locks) {
    if (lock.kind === 'move' && lock.moveKey && lock.move) {
      const i = index.get(lock.moveKey)
      const exec = snapshot.executions[lock.moveKey]
      if (exec && (exec.status === 'done' || exec.status === 'in_progress')) continue
      const m = i !== undefined ? moves[i] : null
      const pinned = lock.move
      const same = m && m.toTrackId === pinned.toTrackId && m.carIds.length === pinned.carIds.length && m.carIds.every((id) => pinned.carIds.includes(id))
      if (!same) violations.push({ code: 'LOCK_VIOLATED', severity: 'physical', moveKey: lock.moveKey, lockId: lock.id, message: `Locked move ${lock.moveKey} (${lock.by}) isn't in this plan as locked` })
    } else if (lock.kind === 'sequence' && lock.moveKey && lock.beforeKey) {
      const a = index.get(lock.moveKey)
      const b = index.get(lock.beforeKey)
      if (a !== undefined && b !== undefined && a > b) {
        violations.push({ code: 'LOCK_VIOLATED', severity: 'physical', moveKey: lock.moveKey, lockId: lock.id, message: `${lock.moveKey} is pinned ahead of ${lock.beforeKey} (${lock.by}), but comes after it here` })
      }
    } else if (lock.kind === 'car_track' && lock.carId && lock.trackId) {
      const car = carOf.get(lock.carId)
      if (!car || car.position === 'departed') continue
      if (car.trackId === lock.trackId || car.coupledTo) continue
      const landing = moves.find((m) => m.kind === 'classify' && m.carIds.includes(lock.carId as string))
      if (!landing || landing.toTrackId !== lock.trackId) {
        violations.push({ code: 'LOCK_VIOLATED', severity: 'physical', lockId: lock.id, carIds: [lock.carId], trackId: lock.trackId, message: `${lock.carId} is locked to ${lock.trackId} (${lock.by}) but doesn't land there in this plan` })
      }
    }
  }
}

export function validatePlan(snapshot: YardSnapshot, moves: PlanMove[]): ValidationResult {
  const r = replay(snapshot, moves)
  const violations = [...r.violations]
  const peakFt = checkTracks(snapshot, r, violations)
  const readiness = checkTrains(snapshot, r, moves, violations)
  checkLocks(snapshot, moves, violations)
  return {
    ok: violations.length === 0,
    publishable: violations.length === 0,
    violations,
    readiness,
    timeline: r.timeline,
    peakFt,
  }
}

/**
 * Re-times an edited list using the validator's own clock. Moves in `moved` lose
 * their not-before time, so dragging a move earlier really does make it earlier.
 */
export function retime(snapshot: YardSnapshot, moves: PlanMove[], moved: Set<string>): PlanMove[] {
  const r = replay(snapshot, moves, moved)
  return moves.map((m) => {
    const t = r.timeline[m.key]
    return t ? { ...m, plannedStart: t.start, plannedEnd: t.end } : m
  })
}
