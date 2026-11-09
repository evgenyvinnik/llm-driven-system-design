/**
 * Yardmaster locks. A lock is an input to every later solve, stored apart from
 * any plan version. Creating one only queues a replan when the working plan
 * doesn't already honour it. A lock the planner can't honour surfaces as a
 * conflict on the draft and stays active until a person releases or changes it.
 * @module plans/locks
 */
import type pg from 'pg'
import { HttpError } from '../shared/errors.js'
import { overridesTotal } from '../shared/metrics.js'
import { readSnapshotWith } from './snapshot.js'
import { addTrigger, readYard } from './state.js'
import { loadMoves } from './versions.js'

export interface LockRequest {
  kind: 'move' | 'car_track'
  moveKey?: string
  carId?: string
  trackId?: string
  reason: string
  reasonCode: string
  /** Needed to lock a car to a track outside its block's standing order. */
  overrideSoft?: boolean
}

export async function createLock(client: pg.PoolClient, req: LockRequest, by: string) {
  const yard = await readYard(client, true)
  const snapshot = await readSnapshotWith(client)
  const moves = yard.workingVersionId ? await loadMoves(client, yard.workingVersionId) : []
  const record = async (kind: string, before: unknown, after: unknown, violations: unknown[] = [], refused = false) => {
    await client.query(
      `INSERT INTO overrides (shift_id, kind, actor, reason, reason_code, before, after, violations, refused, sim_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [yard.shiftId, kind, by, req.reason, req.reasonCode, JSON.stringify(before), JSON.stringify(after), JSON.stringify(violations), refused, yard.simNow.toISOString()],
    )
    overridesTotal.inc({ kind })
  }
  if (req.kind === 'move') {
    const move = moves.find((m) => m.key === req.moveKey)
    if (!move) throw new HttpError(404, 'MOVE_NOT_FOUND', `Move ${req.moveKey} isn't in the working plan`)
    const heldCars = move.carIds.filter((id) => snapshot.cars.find((c) => c.id === id)?.held)
    if (heldCars.length > 0 && move.kind !== 'setout' && move.kind !== 'receive') {
      throw new HttpError(422, 'SAFETY_RULE', `Move ${move.key} carries ${heldCars.join(', ')}, which is on hold. A hold can't be locked past.`)
    }
    const { rows } = await client.query(
      `INSERT INTO locks (shift_id, kind, move_key, move, created_by, reason) VALUES ($1, 'move', $2, $3, $4, $5)
       ON CONFLICT (shift_id, move_key) WHERE active AND kind = 'move' DO NOTHING RETURNING id`,
      [yard.shiftId, move.key, JSON.stringify(move), by, req.reason],
    )
    if (!rows[0]) return { id: null, alreadyLocked: true, replanQueued: false }
    await record('lock_move', null, { moveKey: move.key, toTrackId: move.toTrackId, carIds: move.carIds })
    return { id: rows[0].id as string, alreadyLocked: false, replanQueued: false }
  }

  const car = snapshot.cars.find((c) => c.id === req.carId)
  const track = snapshot.tracks.find((t) => t.id === req.trackId)
  if (!car) throw new HttpError(404, 'CAR_NOT_FOUND', `Car ${req.carId} isn't in this yard`)
  if (!track) throw new HttpError(404, 'TRACK_NOT_FOUND', `Track ${req.trackId} doesn't exist`)
  if (car.held) throw new HttpError(422, 'SAFETY_RULE', `${car.id} is on hold. A hold can't be locked past.`)
  if (track.kind !== 'classification') throw new HttpError(422, 'WRONG_TRACK_KIND', `Cars can only be locked to a classification track`)
  const block = snapshot.blocks.find((b) => b.id === car.blockId)
  let standingOverride: unknown = null
  if (block && track.id !== block.standingTrackId && !block.alternateTrackIds.includes(track.id)) {
    if (!req.overrideSoft) {
      throw new HttpError(422, 'NEEDS_OVERRIDE', `Block ${block.id} has a standing order for ${block.standingTrackId}. Locking ${car.id} to ${track.id} overrides it, which needs a recorded reason.`, {
        violations: [{ code: 'STANDING_ORDER', severity: 'operating', trackId: track.id, message: `Block ${block.id}: ${track.id} is outside the standing order` }],
        overridable: true,
      })
    }
    await client.query(`UPDATE blocks SET override_track_ids = array_append(override_track_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(override_track_ids))`, [block.id, track.id])
    standingOverride = { block: block.id, track: track.id }
  }
  await client.query(`UPDATE locks SET active = FALSE, released_by = $3, released_reason = 'replaced by a new lock', released_at = now() WHERE shift_id = $1 AND car_id = $2 AND active AND kind = 'car_track'`, [yard.shiftId, car.id, by])
  const { rows } = await client.query(`INSERT INTO locks (shift_id, kind, car_id, track_id, created_by, reason) VALUES ($1, 'car_track', $2, $3, $4, $5) RETURNING id`, [yard.shiftId, car.id, track.id, by, req.reason])
  const currentLanding = moves.find((m) => m.kind === 'classify' && m.carIds.includes(car.id))
  await record('lock_car_track', { carId: car.id, trackId: currentLanding?.toTrackId ?? car.trackId }, { carId: car.id, trackId: track.id, standingOverride })
  const honoured = currentLanding?.toTrackId === track.id || car.trackId === track.id
  if (!honoured) await addTrigger(client, 'lock_changed', { lockId: rows[0].id, carId: car.id, trackId: track.id }, yard.stateVersion, yard.shiftId)
  return { id: rows[0].id as string, alreadyLocked: false, replanQueued: !honoured }
}

export async function releaseLock(client: pg.PoolClient, id: string, by: string, reason: string, reasonCode: string) {
  const yard = await readYard(client, true)
  const { rows } = await client.query(`UPDATE locks SET active = FALSE, released_by = $2, released_reason = $3, released_at = now() WHERE id = $1 AND active RETURNING *`, [id, by, reason])
  if (!rows[0]) throw new HttpError(404, 'LOCK_NOT_FOUND', 'No active lock with that id')
  const lock = rows[0]
  await client.query(
    `INSERT INTO overrides (shift_id, kind, actor, reason, reason_code, before, after, sim_at) VALUES ($1, 'unlock', $2, $3, $4, $5, NULL, $6)`,
    [yard.shiftId, by, reason, reasonCode, JSON.stringify({ lockId: id, kind: lock.kind, moveKey: lock.move_key, beforeKey: lock.before_key, carId: lock.car_id, trackId: lock.track_id }), yard.simNow.toISOString()],
  )
  overridesTotal.inc({ kind: 'unlock' })
  await addTrigger(client, 'lock_changed', { lockId: id, released: true }, yard.stateVersion, yard.shiftId)
  return { released: true, replanQueued: true }
}
