/**
 * What a plan means for people: lock conflicts the yardmaster must resolve, and
 * consequences reported in plain words (a missed departure, rolled cars) instead
 * of being absorbed into an objective value nobody reads.
 * @module planner/outcome
 */
import { MIN, moveDurationMin } from '../domain/params.js'
import type { Consequence, LockConflict, PlanMove } from '../domain/types.js'
import type { Decoded } from './decode.js'
import type { Problem } from './problem.js'

function assignmentOf(moves: PlanMove[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of moves) if (m.kind === 'assemble' && m.outboundId) for (const id of m.carIds) out[id] = m.outboundId
  return out
}

export function deriveConsequences(p: Problem, d: Decoded): Consequence[] {
  const out: Consequence[] = [...p.preConsequences]
  for (const dropped of d.droppedFixed) {
    if (dropped.pinned && !dropped.lockId) {
      out.push({ kind: 'frozen_move_changed', moveKey: dropped.key, reason: dropped.reason, message: `Move ${dropped.key} was inside the frozen horizon but couldn't stay: ${dropped.reason}` })
    }
  }
  const before = p.baseline ? assignmentOf(p.baseline) : {}
  const after: Record<string, string | null> = d.assignment
  const r = p.rules
  const rollGroups = new Map<string, { from: string; to: string | null; cars: string[] }>()
  for (const [carId, from] of Object.entries(before)) {
    const to = after[carId] ?? null
    if (to === from || !p.trainById[from]) continue
    if (p.frozen.some((m) => m.kind === 'assemble' && m.carIds.includes(carId))) continue
    const key = `${from}>${to}`
    if (!rollGroups.has(key)) rollGroups.set(key, { from, to, cars: [] })
    rollGroups.get(key)!.cars.push(carId)
  }
  for (const g of rollGroups.values()) {
    const from = p.trainById[g.from]
    const to = g.to ? p.trainById[g.to] : null
    out.push({
      kind: 'cars_rolled',
      outboundId: g.from,
      toOutboundId: g.to,
      carIds: g.cars,
      message: to
        ? `${g.cars.length} cars moved from ${from.symbol} to ${to.symbol} (${Math.abs(Math.round((to.departure - from.departure) / MIN))} min ${to.departure >= from.departure ? 'later' : 'earlier'})`
        : `${g.cars.length} cars rolled off ${from.symbol} with no later train in this shift`,
    })
  }
  for (const t of p.trains) {
    const outcome = d.trains[t.id]
    if (!outcome?.annulled) continue
    const previously = Object.entries(before).filter(([, id]) => id === t.id).map(([id]) => id)
    const wanting = previously.length > 0 ? previously : p.groups.filter((g) => t.blockSequence.includes(g.blockId)).flatMap((g) => g.cars.map((c) => c.id))
    let lastReady = 0
    for (const id of wanting) lastReady = Math.max(lastReady, p.carEarliest[id] ?? p.now)
    const earliestReady = wanting.length > 0 ? lastReady + (moveDurationMin(r, 'assemble', wanting.length) + r.brakeTestMin) * MIN : null
    const lateBy = earliestReady ? Math.round((earliestReady - t.departure) / MIN) : null
    out.push({
      kind: 'departure_missed',
      outboundId: t.id,
      earliestReady,
      carIds: previously,
      reason: previously.length > 0 ? 'was_planned' : 'never_planned',
      message:
        `${t.symbol} misses its ${new Date(t.departure).toISOString().slice(11, 16)}Z departure: fewer than its minimum of ${t.minCars} cars can be coupled in time` +
        (lateBy && lateBy > 0 ? `; its cars could be ready about ${lateBy} min after departure` : '') +
        (previously.length > 0 ? ` (${previously.length} cars were planned on it)` : ''),
    })
  }
  const unassignedByReason = new Map<string, string[]>()
  for (const u of d.unassigned) {
    if (!unassignedByReason.has(u.reason)) unassignedByReason.set(u.reason, [])
    unassignedByReason.get(u.reason)!.push(u.carId)
  }
  for (const [reason, cars] of unassignedByReason) {
    out.push({ kind: 'cars_unassigned', carIds: cars, reason, message: `${cars.length} cars have no train this shift: ${reason}` })
  }
  return out
}

export function verifyLocks(p: Problem, d: Decoded): LockConflict[] {
  const conflicts: LockConflict[] = []
  const byKey = new Map(d.allMoves.map((m, i) => [m.key, { m, i }]))
  for (const lock of p.activeLocks) {
    if (lock.kind === 'car_track' && lock.carId && lock.trackId) {
      const car = p.cars[lock.carId]
      if (!car || car.position === 'departed') continue
      const base = { lockId: lock.id, carId: lock.carId, trackId: lock.trackId, options: ['release_lock', 'retarget_lock'] as LockConflict['options'] }
      if (car.held) {
        conflicts.push({ ...base, code: 'LOCK_HELD_CAR', message: `${lock.carId} is locked to ${lock.trackId} but is on hold; a hold always wins` })
        continue
      }
      if (!p.tracks[lock.trackId]?.open) {
        conflicts.push({ ...base, code: 'LOCK_TRACK_BLOCKED', message: `${lock.carId} is locked to ${lock.trackId}, which is blocked` })
        continue
      }
      if (car.trackId === lock.trackId) continue
      const landed = d.allMoves.find((m) => m.kind === 'classify' && m.carIds.includes(lock.carId as string))
      if (landed?.toTrackId === lock.trackId) continue
      if (car.coupledTo) continue
      conflicts.push({ ...base, code: 'LOCK_CAPACITY', message: `${lock.carId} can't be placed on ${lock.trackId}: no room or wrong block on the track when its cut is humped` })
    } else if (lock.kind === 'move' && lock.moveKey && lock.move) {
      if (p.frozenKeys.has(lock.moveKey)) continue
      const hit = byKey.get(lock.moveKey)
      // A lock pins where the cars go. The receiving track they start from can still change with the train's arrival.
      if (hit && hit.m.toTrackId === lock.move.toTrackId && hit.m.carIds.length === lock.move.carIds.length && hit.m.carIds.every((id) => lock.move?.carIds.includes(id))) continue
      const base = { lockId: lock.id, moveKey: lock.moveKey, options: ['release_lock'] as LockConflict['options'] }
      const held = lock.move.carIds.filter((id) => p.cars[id]?.held)
      const dropped = d.droppedFixed.find((x) => x.lockId === lock.id)
      if (held.length > 0) {
        conflicts.push({ ...base, code: 'LOCK_HELD_CAR', message: `Locked move ${lock.moveKey} carries ${held.join(', ')}, which is on hold; a hold always wins` })
      } else if (!p.tracks[lock.move.toTrackId]?.open) {
        conflicts.push({ ...base, code: 'LOCK_TRACK_BLOCKED', trackId: lock.move.toTrackId, message: `Locked move ${lock.moveKey} targets ${lock.move.toTrackId}, which is blocked` })
      } else if (dropped?.reason.includes('departure') || dropped?.reason.includes('annulled')) {
        conflicts.push({
          ...base,
          code: 'LOCK_MISSES_DEPARTURE',
          options: ['release_lock', 'revise_departure'],
          message: `Locked move ${lock.moveKey} can't finish before its train leaves`,
        })
      } else if (dropped?.reason.includes('room')) {
        conflicts.push({ ...base, code: 'LOCK_CAPACITY', message: `Locked move ${lock.moveKey} has no room on ${lock.move.toTrackId}` })
      } else {
        conflicts.push({ ...base, code: 'LOCK_NOT_HONOURED', message: `Locked move ${lock.moveKey} couldn't stay as locked: ${dropped?.reason ?? 'its cars are no longer where the lock expects them'}` })
      }
    } else if (lock.kind === 'sequence' && lock.moveKey && lock.beforeKey) {
      const a = byKey.get(lock.moveKey)
      const b = byKey.get(lock.beforeKey)
      if (a && b && a.i > b.i) {
        conflicts.push({
          lockId: lock.id,
          moveKey: lock.moveKey,
          code: 'LOCK_SEQUENCE',
          options: ['release_lock'],
          message: `${lock.moveKey} is pinned ahead of ${lock.beforeKey}, but that order can't be kept`,
        })
      }
    }
  }
  return conflicts
}
