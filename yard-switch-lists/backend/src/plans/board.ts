/**
 * Read models for the yardmaster board and the crew handheld. Track occupancy
 * comes from where crews said cars are, never from the plan. Rows are mapped to
 * camelCase DTOs here so no handler ever returns a raw database row.
 * @module plans/board
 */
import type { Queryable } from '../shared/db.js'
import type { Consequence, LockConflict, PlanMove, YardSnapshot } from '../domain/types.js'
import { validatePlan } from '../validator/validate.js'
import { readSnapshotWith } from './snapshot.js'
import { readYard } from './state.js'
import { loadMoves, loadVersion, type VersionRow } from './versions.js'

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

export function moveDto(m: PlanMove, snapshot: YardSnapshot, lockKeys: Map<string, string>, heldCars: Set<string>) {
  const exec = snapshot.executions[m.key]
  return {
    key: m.key,
    kind: m.kind,
    crew: m.crew,
    carIds: m.carIds,
    carCount: m.carIds.length,
    fromTrackId: m.fromTrackId,
    toTrackId: m.toTrackId,
    blockId: m.blockId,
    inboundId: m.inboundId,
    outboundId: m.outboundId,
    plannedStart: iso(m.plannedStart),
    plannedEnd: iso(m.plannedEnd),
    status: exec?.status ?? 'pending',
    startedAt: iso(exec?.startedAt),
    completedAt: iso(exec?.completedAt),
    lockId: lockKeys.get(m.key) ?? null,
    heldCars: m.carIds.filter((id) => heldCars.has(id)),
  }
}

export function versionDto(v: VersionRow) {
  return {
    id: v.id,
    shiftId: v.shiftId,
    versionNo: v.versionNo,
    status: v.status,
    parentId: v.parentId,
    authorKind: v.authorKind,
    authorName: v.authorName,
    reason: v.reason,
    basedOnStateVersion: v.basedOnStateVersion,
    solveId: v.solveId,
    objective: v.objective,
    validation: v.validation,
    conflicts: v.conflicts as LockConflict[],
    consequences: v.consequences as Consequence[],
    stability: v.stability,
    reviewRequired: v.reviewRequired,
    createdAt: v.createdAt,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
    supersededAt: v.supersededAt,
  }
}

export async function buildBoard(db: Queryable) {
  const yard = await readYard(db)
  const snapshot = await readSnapshotWith(db)
  const head = yard.headVersionId ? await loadVersion(db, yard.headVersionId) : null
  const working = yard.workingVersionId ? await loadVersion(db, yard.workingVersionId) : null
  const showId = working?.id ?? head?.id ?? null
  const moves = showId ? await loadMoves(db, showId) : []
  const heldCars = new Set(snapshot.cars.filter((c) => c.held).map((c) => c.id))
  const lockKeys = new Map<string, string>()
  for (const l of snapshot.locks) if (l.kind === 'move' && l.moveKey) lockKeys.set(l.moveKey, l.id)
  const validation = validatePlan(snapshot, moves)
  const carsByTrack: Record<string, typeof snapshot.cars> = {}
  for (const c of snapshot.cars) {
    if (c.position === 'on_track' && c.trackId) (carsByTrack[c.trackId] ??= []).push(c)
  }
  const tracks = snapshot.tracks.map((t) => {
    const list = carsByTrack[t.id] ?? []
    const feet = list.reduce((s, c) => s + c.lengthFt, 0)
    const blocks: Record<string, number> = {}
    for (const c of list) blocks[c.blockId] = (blocks[c.blockId] ?? 0) + 1
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      capacityFt: t.capacityFt,
      open: t.open,
      occupiedFt: feet,
      carCount: list.length,
      peakPlannedFt: validation.peakFt[t.id] ?? feet,
      blocks,
      cars: list
        .sort((a, b) => (a.coupledSeq ?? a.consistPos) - (b.coupledSeq ?? b.consistPos) || a.id.localeCompare(b.id))
        .map((c) => ({ id: c.id, blockId: c.blockId, lengthFt: c.lengthFt, hazmatClass: c.hazmatClass, held: c.held, coupledTo: c.coupledTo })),
    }
  })
  const { rows: alertRows } = await db.query(`SELECT * FROM alerts WHERE status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 30`)
  const { rows: solving } = await db.query(`SELECT id, purpose, status, reason, attempts, trigger_count, queued_at FROM solve_jobs WHERE lane = 'plan' AND status IN ('queued', 'running') ORDER BY queued_at LIMIT 5`)
  const { rows: pending } = await db.query(`SELECT count(*)::int AS n FROM replan_triggers WHERE solve_id IS NULL AND shift_id = $1`, [yard.shiftId])
  const { rows: locks } = await db.query(`SELECT id, kind, move_key, before_key, car_id, track_id, created_by, reason, created_at FROM locks WHERE shift_id = $1 AND active ORDER BY created_at DESC`, [yard.shiftId])
  const { rows: bounds } = await db.query(`SELECT starts_at, ends_at FROM shifts WHERE id = $1`, [yard.shiftId])
  const carTotal = snapshot.cars.filter((c) => c.position !== 'departed').length
  return {
    now: iso(snapshot.now),
    shiftId: yard.shiftId,
    shiftStartsAt: bounds[0]?.starts_at ?? null,
    shiftEndsAt: bounds[0]?.ends_at ?? null,
    stateVersion: yard.stateVersion,
    autoPublish: yard.autoPublish,
    head: head ? versionDto(head) : null,
    working: working ? versionDto(working) : null,
    workingIsHead: Boolean(working && head && working.id === head.id),
    stale: Boolean(working && working.basedOnStateVersion !== yard.stateVersion),
    moves: moves.map((m) => moveDto(m, snapshot, lockKeys, heldCars)),
    validation: { ok: validation.ok, violations: validation.violations },
    readiness: validation.readiness.map((r) => ({ ...r, departure: iso(r.departure), scheduledDeparture: iso(r.scheduledDeparture), readyAt: iso(r.readyAt) })),
    tracks,
    inbound: snapshot.inbound.map((i) => ({ id: i.id, symbol: i.symbol, scheduledArrival: iso(i.scheduledArrival), eta: iso(i.eta), actualArrival: iso(i.actualArrival), receivingTrackId: i.receivingTrackId, carCount: snapshot.cars.filter((c) => c.inboundId === i.id).length, slipMin: Math.round((i.eta - i.scheduledArrival) / 60_000) })),
    alerts: alertRows.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, message: a.message, carId: a.car_id, outboundId: a.outbound_id, moveKey: a.move_key, simAt: a.sim_at })),
    solving: solving.map((s) => ({ id: s.id, purpose: s.purpose, status: s.status, reason: s.reason, attempts: s.attempts, triggerCount: s.trigger_count })),
    pendingTriggers: pending[0].n as number,
    locks: locks.map((l) => ({ id: l.id, kind: l.kind, moveKey: l.move_key, beforeKey: l.before_key, carId: l.car_id, trackId: l.track_id, by: l.created_by, reason: l.reason, createdAt: l.created_at })),
    carsInYard: carTotal,
  }
}

/** The crew's view: the published list only. Someone in a cab never sees a draft. */
export async function buildCrewView(db: Queryable, crew: 'hump' | 'trim' | 'all') {
  const yard = await readYard(db)
  const snapshot = await readSnapshotWith(db)
  const head = yard.headVersionId ? await loadVersion(db, yard.headVersionId) : null
  const moves = head ? await loadMoves(db, head.id) : []
  const heldCars = new Set(snapshot.cars.filter((c) => c.held).map((c) => c.id))
  const carOf = new Map(snapshot.cars.map((c) => [c.id, c]))
  const lockKeys = new Map<string, string>()
  const waiting = new Set<string>()
  const list = []
  for (const m of moves) {
    if (m.crew === 'road') continue
    const exec = snapshot.executions[m.key]
    const status = exec?.status ?? 'pending'
    if (status === 'done' || status === 'cancelled') continue
    const onFrom = m.carIds.every((id) => {
      const car = carOf.get(id)
      return car && car.position === 'on_track' && car.trackId === m.fromTrackId
    })
    const sequenceOk = !(m.kind === 'assemble' && m.outboundId && waiting.has(m.outboundId))
    const blockedByHold = m.kind !== 'setout' && m.carIds.some((id) => heldCars.has(id))
    const ready = status === 'in_progress' || (onFrom && sequenceOk && !blockedByHold)
    if (!ready && m.kind === 'assemble' && m.outboundId) waiting.add(m.outboundId)
    if (crew !== 'all' && m.crew !== crew) continue
    list.push({ ...moveDto(m, snapshot, lockKeys, heldCars), ready, blockedByHold })
  }
  return {
    now: iso(snapshot.now),
    shiftId: yard.shiftId,
    stateVersion: yard.stateVersion,
    versionNo: head?.versionNo ?? null,
    versionId: head?.id ?? null,
    replanPending: Boolean(yard.workingVersionId && yard.workingVersionId !== yard.headVersionId),
    trains: Object.fromEntries(snapshot.outbound.map((t) => [t.id, t.symbol])),
    moves: list,
    tracks: snapshot.tracks.map((t) => ({ id: t.id, name: t.name, open: t.open })),
  }
}
