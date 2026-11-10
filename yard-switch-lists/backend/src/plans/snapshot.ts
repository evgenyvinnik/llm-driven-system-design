/**
 * Reads the whole yard as one consistent snapshot: the explicit input to a solve
 * and to the validator. Inside a REPEATABLE READ transaction every query below
 * sees the same commit, so state_version really does describe the rows returned.
 * @module plans/snapshot
 */
import type { Queryable } from '../shared/db.js'
import { withSnapshotRead } from '../shared/db.js'
import { DEFAULT_RULES } from '../domain/params.js'
import type { CarState, ExecutionStatus, InboundDef, LockDef, MoveExecution, OutboundDef, PlanMove, TrackDef, YardRules, YardSnapshot } from '../domain/types.js'
import { YARD_ID, readYard } from './state.js'

const ms = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null)

function reviveMove(m: Record<string, unknown> | null): PlanMove | null {
  if (!m) return null
  return m as unknown as PlanMove
}

export async function readSnapshotWith(db: Queryable): Promise<YardSnapshot> {
  const yard = await readYard(db)
  const shiftId = yard.shiftId
  // One after another: these all run on one client inside one snapshot.
  const tracks = await db.query(`SELECT * FROM tracks ORDER BY id`)
  const blocks = await db.query(`SELECT * FROM blocks ORDER BY id`)
  const cars = await db.query(`SELECT * FROM cars WHERE position <> 'departed' OR shift_id = $1 ORDER BY id`, [shiftId])
  const inbound = await db.query(`SELECT * FROM inbound_trains WHERE shift_id = $1 ORDER BY id`, [shiftId])
  const outbound = await db.query(`SELECT * FROM outbound_trains WHERE shift_id = $1 ORDER BY id`, [shiftId])
  const locks = await db.query(`SELECT * FROM locks WHERE shift_id = $1 AND active ORDER BY created_at, id`, [shiftId])
  const execs = await db.query(`SELECT * FROM move_executions WHERE shift_id = $1`, [shiftId])
  const holds = await db.query(`SELECT DISTINCT car_id FROM car_holds WHERE status IN ('active', 'bad_ordered')`)
  const rulesRow = await db.query(`SELECT rules FROM yard_state WHERE yard_id = $1`, [YARD_ID])
  const held = new Set(holds.rows.map((r) => r.car_id as string))
  const executions: Record<string, MoveExecution> = {}
  for (const e of execs.rows) {
    executions[e.key] = {
      key: e.key,
      status: e.status as ExecutionStatus,
      startedAt: ms(e.started_at),
      completedAt: ms(e.completed_at),
      move: reviveMove(e.move),
    }
  }
  return {
    yardId: YARD_ID,
    shiftId,
    stateVersion: yard.stateVersion,
    now: yard.simNow.getTime(),
    tracks: tracks.rows.map((t): TrackDef => ({ id: t.id, name: t.name, kind: t.kind, capacityFt: t.capacity_ft, open: t.is_open })),
    blocks: blocks.rows.map((b) => ({
      id: b.id,
      name: b.name,
      destination: b.destination,
      standingTrackId: b.standing_track_id,
      alternateTrackIds: [...b.alternate_track_ids, ...b.override_track_ids],
    })),
    cars: cars.rows.map((c): CarState => ({
      id: c.id,
      lengthFt: c.length_ft,
      tons: c.tons,
      blockId: c.block_id,
      hazmatClass: c.hazmat_class,
      inboundId: c.inbound_id,
      consistPos: c.consist_pos,
      position: c.position,
      trackId: c.track_id,
      held: held.has(c.id),
      coupledTo: c.coupled_to,
      coupledSeq: c.coupled_seq === null ? null : Number(c.coupled_seq),
      arrivedAt: ms(c.arrived_at),
    })),
    inbound: inbound.rows.map((i): InboundDef => ({
      id: i.id,
      symbol: i.symbol,
      scheduledArrival: ms(i.scheduled_arrival) as number,
      eta: ms(i.eta) as number,
      actualArrival: ms(i.actual_arrival),
      receivingTrackId: i.receiving_track_id,
    })),
    outbound: outbound.rows.map((o): OutboundDef => ({
      id: o.id,
      symbol: o.symbol,
      scheduledDeparture: ms(o.scheduled_departure) as number,
      departure: ms(o.revised_departure ?? o.scheduled_departure) as number,
      blockSequence: o.block_sequence,
      maxLengthFt: o.max_length_ft,
      maxTons: o.max_tons,
      minCars: o.min_cars,
      status: o.status,
    })),
    locks: locks.rows.map((l): LockDef => ({
      id: l.id,
      kind: l.kind,
      moveKey: l.move_key,
      beforeKey: l.before_key,
      carId: l.car_id,
      trackId: l.track_id,
      move: reviveMove(l.move),
      by: l.created_by,
      reason: l.reason,
    })),
    executions,
    rules: { ...DEFAULT_RULES, ...((rulesRow.rows[0]?.rules ?? {}) as Partial<YardRules>) },
  }
}

/** One consistent read, in its own read-only transaction. */
export function readSnapshot(): Promise<YardSnapshot> {
  return withSnapshotRead((client) => readSnapshotWith(client))
}
