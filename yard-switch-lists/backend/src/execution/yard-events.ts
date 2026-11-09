/**
 * Facts from outside the crew: train arrivals, ETA changes, departures, track
 * status and the simulated clock. They come from the simulator or from a
 * yardmaster; in production from dispatch and yard systems.
 * @module execution/yard-events
 */
import type pg from 'pg'
import type { Queryable } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { overridesTotal } from '../shared/metrics.js'
import { raiseAlert, readYard, resolveAlert, surprise } from '../plans/state.js'
import { loadMoves } from '../plans/versions.js'

const MIN = 60_000
/** Arriving within this of the ETA isn't news. */
const ARRIVAL_TOLERANCE_MIN = 15
const ON_TIME_TOLERANCE_MIN = 15

export async function advanceClock(client: Queryable, nowIso: string): Promise<void> {
  await client.query(`UPDATE yard_state SET sim_now = GREATEST(sim_now, $1::timestamptz), updated_at = now()`, [nowIso])
}

export async function slipTrain(client: pg.PoolClient, inboundId: string, etaIso: string, actor: string, reason: string) {
  await readYard(client, true)
  const { rows } = await client.query(`SELECT * FROM inbound_trains WHERE id = $1`, [inboundId])
  const train = rows[0]
  if (!train) throw new HttpError(404, 'TRAIN_NOT_FOUND', `Inbound train ${inboundId} not found`)
  if (train.actual_arrival) throw new HttpError(409, 'ALREADY_ARRIVED', `${train.symbol} has already arrived`)
  const before = new Date(train.eta).getTime()
  const after = new Date(etaIso).getTime()
  await client.query(`UPDATE inbound_trains SET eta = $2 WHERE id = $1`, [inboundId, etaIso])
  const slipMin = Math.round((after - before) / MIN)
  const version = await surprise(client, 'late_train', { inboundId, symbol: train.symbol, slipMin, from: new Date(before).toISOString(), to: etaIso, reason }, actor)
  return { inboundId, symbol: train.symbol, slipMin, stateVersion: version }
}

export async function recordArrival(client: pg.PoolClient, inboundId: string, atIso: string, trackId: string | undefined, actor: string) {
  const yard = await readYard(client, true)
  const { rows } = await client.query(`SELECT * FROM inbound_trains WHERE id = $1`, [inboundId])
  const train = rows[0]
  if (!train) throw new HttpError(404, 'TRAIN_NOT_FOUND', `Inbound train ${inboundId} not found`)
  if (train.actual_arrival) return { inboundId, duplicate: true, trackId: train.receiving_track_id }
  const key = `receive:${inboundId}`
  const head = yard.headVersionId ? await loadMoves(client, yard.headVersionId) : []
  const planned = head.find((m) => m.key === key)
  const { rows: carRows } = await client.query(`SELECT id, length_ft FROM cars WHERE inbound_id = $1 AND position = 'inbound' ORDER BY consist_pos`, [inboundId])
  const length = carRows.reduce((s, c) => s + c.length_ft, 0)
  const { rows: tracks } = await client.query(
    `SELECT t.id, t.capacity_ft, t.is_open, COALESCE(SUM(c.length_ft) FILTER (WHERE c.position = 'on_track'), 0)::int AS feet
       FROM tracks t LEFT JOIN cars c ON c.track_id = t.id WHERE t.kind = 'receiving' GROUP BY t.id ORDER BY t.id`,
  )
  const open = tracks.filter((t) => t.is_open)
  const fits = (id: string | undefined) => open.find((t) => t.id === id && t.feet + length <= t.capacity_ft)
  const chosen = fits(trackId)?.id ?? fits(planned?.toTrackId)?.id ?? open.find((t) => t.feet + length <= t.capacity_ft)?.id ?? open.slice().sort((a, b) => a.feet - b.feet)[0]?.id
  if (!chosen) throw new HttpError(409, 'NO_RECEIVING_TRACK', 'Every receiving track is blocked')
  await client.query(`UPDATE inbound_trains SET actual_arrival = $2, receiving_track_id = $3 WHERE id = $1`, [inboundId, atIso, chosen])
  await client.query(`UPDATE cars SET position = 'on_track', track_id = $2, arrived_at = $3, position_as_of = $3 WHERE inbound_id = $1 AND position = 'inbound'`, [inboundId, chosen, atIso])
  await client.query(
    `INSERT INTO move_executions (shift_id, key, status, crew_name, started_at, completed_at, move)
     VALUES ($1, $2, 'done', 'road crew', $3, $3, $4)
     ON CONFLICT (shift_id, key) DO UPDATE SET status = 'done', started_at = $3, completed_at = $3, move = EXCLUDED.move, updated_at = now()`,
    [
      yard.shiftId,
      key,
      atIso,
      JSON.stringify({
        key,
        kind: 'receive',
        crew: 'road',
        carIds: carRows.map((c) => c.id),
        fromTrackId: null,
        toTrackId: chosen,
        blockId: null,
        inboundId,
        outboundId: null,
        plannedStart: new Date(atIso).getTime(),
        plannedEnd: new Date(atIso).getTime() + 15 * MIN,
      }),
    ],
  )
  const offEta = Math.abs(new Date(atIso).getTime() - new Date(train.eta).getTime()) / MIN
  let version: number | undefined
  if (!planned || offEta > ARRIVAL_TOLERANCE_MIN || planned.toTrackId !== chosen) {
    version = await surprise(client, 'arrival_deviation', { inboundId, symbol: train.symbol, offEtaMin: Math.round(offEta), trackId: chosen, plannedTrack: planned?.toTrackId ?? null }, actor)
  }
  return { inboundId, duplicate: false, trackId: chosen, stateVersion: version }
}

export async function recordDeparture(client: pg.PoolClient, outboundId: string, atIso: string, actor: string) {
  const yard = await readYard(client, true)
  const { rows } = await client.query(`SELECT * FROM outbound_trains WHERE id = $1`, [outboundId])
  const train = rows[0]
  if (!train) throw new HttpError(404, 'TRAIN_NOT_FOUND', `Outbound train ${outboundId} not found`)
  if (train.status !== 'planned') return { outboundId, status: train.status as string, duplicate: true, cars: train.car_count as number }
  const { rows: cars } = await client.query(`SELECT id, length_ft, track_id FROM cars WHERE coupled_to = $1 AND position = 'on_track'`, [outboundId])
  const { rows: held } = await client.query(`SELECT DISTINCT car_id FROM car_holds WHERE car_id = ANY($1) AND status IN ('active', 'bad_ordered')`, [cars.map((c) => c.id)])
  if (held.length > 0) {
    // A hold is a safety rule. The train waits; lateness is what it costs.
    await raiseAlert(client, { dedupKey: `departure-blocked:${outboundId}`, kind: 'departure_blocked', severity: 'critical', outboundId, carId: held[0].car_id, message: `${train.symbol} can't leave: ${held.map((h) => h.car_id).join(', ')} is on hold and coupled. Set it out.` })
    return { outboundId, status: 'blocked' as const, duplicate: false, cars: cars.length, heldCars: held.map((h) => h.car_id as string) }
  }
  await resolveAlert(client, `departure-blocked:${outboundId}`)
  if (cars.length < train.min_cars && cars.length === 0) {
    await client.query(`UPDATE outbound_trains SET status = 'missed', car_count = 0, note = $2 WHERE id = $1`, [outboundId, 'no cars coupled at departure'])
    await raiseAlert(client, { dedupKey: `missed:${outboundId}`, kind: 'train_missed', severity: 'warning', outboundId, message: `${train.symbol} didn't run: no cars were coupled at its departure time.` })
    await cancelTrainMoves(client, yard.shiftId, outboundId, yard.headVersionId)
    return { outboundId, status: 'missed' as const, duplicate: false, cars: 0 }
  }
  const scheduled = new Date(train.scheduled_departure).getTime()
  const lateMin = (new Date(atIso).getTime() - scheduled) / MIN
  await client.query(`UPDATE cars SET position = 'departed', track_id = NULL, departed_at = $2, departed_on = $1 WHERE coupled_to = $1 AND position = 'on_track'`, [outboundId, atIso])
  await client.query(`UPDATE outbound_trains SET status = 'departed', actual_departure = $2, car_count = $3, departure_track_id = $4, note = $5 WHERE id = $1`, [
    outboundId,
    atIso,
    cars.length,
    cars[0]?.track_id ?? null,
    lateMin > ON_TIME_TOLERANCE_MIN ? `${Math.round(lateMin)} min late` : cars.length < train.min_cars ? `short: ${cars.length} of ${train.min_cars} minimum` : null,
  ])
  const cancelled = await cancelTrainMoves(client, yard.shiftId, outboundId, yard.headVersionId)
  let version: number | undefined
  if (cancelled > 0) version = await surprise(client, 'train_left_short', { outboundId, symbol: train.symbol, cancelledMoves: cancelled }, actor)
  return { outboundId, status: 'departed' as const, duplicate: false, cars: cars.length, lateMin: Math.round(lateMin), stateVersion: version }
}

/** The train has gone: its unstarted moves in the published plan can't happen any more. */
async function cancelTrainMoves(client: pg.PoolClient, shiftId: number, outboundId: string, headId: string | null): Promise<number> {
  if (!headId) return 0
  const moves = await loadMoves(client, headId)
  let cancelled = 0
  for (const m of moves) {
    if (m.outboundId !== outboundId || m.kind !== 'assemble') continue
    const { rows } = await client.query(`SELECT status FROM move_executions WHERE shift_id = $1 AND key = $2`, [shiftId, m.key])
    if (rows[0] && rows[0].status !== 'pending') continue
    await client.query(
      `INSERT INTO move_executions (shift_id, key, status, move) VALUES ($1, $2, 'cancelled', $3)
       ON CONFLICT (shift_id, key) DO UPDATE SET status = 'cancelled', updated_at = now()`,
      [shiftId, m.key, JSON.stringify(m)],
    )
    cancelled++
  }
  return cancelled
}

export async function setTrackStatus(client: pg.PoolClient, trackId: string, open: boolean, reason: string, actor: string) {
  const yard = await readYard(client, true)
  const { rows } = await client.query(`SELECT * FROM tracks WHERE id = $1`, [trackId])
  const track = rows[0]
  if (!track) throw new HttpError(404, 'TRACK_NOT_FOUND', `Track ${trackId} not found`)
  if (track.is_open === open) return { trackId, open, changed: false }
  await client.query(`UPDATE tracks SET is_open = $2, blocked_reason = $3, blocked_by = $4, blocked_at = $5 WHERE id = $1`, [trackId, open, open ? null : reason, open ? null : actor, open ? null : yard.simNow.toISOString()])
  const version = await surprise(client, open ? 'track_reopened' : 'track_blocked', { trackId, reason }, actor)
  if (open) await resolveAlert(client, `track:${trackId}:blocked`)
  else await raiseAlert(client, { dedupKey: `track:${trackId}:blocked`, kind: 'track_blocked', severity: 'warning', message: `${track.name} blocked by ${actor}: ${reason}. Replanning around it.` })
  return { trackId, open, changed: true, stateVersion: version }
}

/** Knowingly hold a train: an operating override. It changes the departure both planner and validator read. */
export async function reviseDeparture(client: pg.PoolClient, outboundId: string, departureIso: string, by: string, reason: string, reasonCode: string) {
  const yard = await readYard(client, true)
  const { rows } = await client.query(`SELECT * FROM outbound_trains WHERE id = $1`, [outboundId])
  const train = rows[0]
  if (!train) throw new HttpError(404, 'TRAIN_NOT_FOUND', `Outbound train ${outboundId} not found`)
  if (train.status !== 'planned') throw new HttpError(409, 'TRAIN_GONE', `${train.symbol} has already ${train.status}`)
  const before = train.revised_departure ?? train.scheduled_departure
  await client.query(`UPDATE outbound_trains SET revised_departure = $2 WHERE id = $1`, [train.id, departureIso])
  await client.query(`INSERT INTO overrides (shift_id, kind, actor, reason, reason_code, before, after, violations, sim_at) VALUES ($1, 'revise_departure', $2, $3, $4, $5, $6, $7, $8)`, [
    yard.shiftId,
    by,
    reason,
    reasonCode,
    JSON.stringify({ outboundId: train.id, symbol: train.symbol, departure: new Date(before).toISOString() }),
    JSON.stringify({ outboundId: train.id, symbol: train.symbol, departure: departureIso }),
    JSON.stringify([{ code: 'DEPARTURE_TIME', severity: 'operating' }]),
    yard.simNow.toISOString(),
  ])
  overridesTotal.inc({ kind: 'revise_departure' })
  const version = await surprise(client, 'departure_revised', { outboundId: train.id, symbol: train.symbol, departure: departureIso, by }, by)
  return { outboundId: train.id, departure: departureIso, scheduledDeparture: new Date(train.scheduled_departure).toISOString(), stateVersion: version }
}
