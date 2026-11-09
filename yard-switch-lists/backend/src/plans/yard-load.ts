/**
 * Loads a shift into the yard: its trains and cars from the seeded scenario, and
 * a fresh plan-version series. Used by the seed, the simulator's reset and the
 * next-shift rollover, so they can't drift apart.
 * @module plans/yard-load
 */
import type pg from 'pg'
import { DEFAULT_RULES } from '../domain/params.js'
import { BLOCKS, SHIFT_HOURS, TRACKS, YARD_ID, generateShift, shiftStart } from '../domain/scenario.js'
import { config } from '../shared/config.js'
import { hash32 } from '../shared/rng.js'
import { enqueueSolve } from '../worker/jobs.js'

const OPERATIONAL_TABLES = `moves, switch_lists, move_executions, crew_reports, car_handlings, capacity_events, locks, overrides, solve_jobs, replan_triggers, hold_events, car_holds, alerts, cars, inbound_trains, outbound_trains, shifts, yard_state, yard_state_log, blocks, tracks`

export async function clearOperational(client: pg.PoolClient): Promise<void> {
  await client.query(`ALTER TABLE moves DISABLE TRIGGER moves_immutable`)
  await client.query(`TRUNCATE ${OPERATIONAL_TABLES} CASCADE`)
  await client.query(`ALTER TABLE moves ENABLE TRIGGER moves_immutable`)
}

export async function insertLayout(client: pg.PoolClient): Promise<void> {
  for (const t of TRACKS) await client.query(`INSERT INTO tracks (id, name, kind, capacity_ft, is_open) VALUES ($1, $2, $3, $4, TRUE)`, [t.id, t.name, t.kind, t.capacityFt])
  for (const b of BLOCKS) await client.query(`INSERT INTO blocks (id, name, destination, standing_track_id, alternate_track_ids) VALUES ($1, $2, $3, $4, $5)`, [b.id, b.name, b.destination, b.standingTrackId, b.alternateTrackIds])
}

export async function insertShift(client: pg.PoolClient, seed: number, shiftIndex: number): Promise<void> {
  const s = generateShift(seed, shiftIndex)
  const iso = (ms: number) => new Date(ms).toISOString()
  await client.query(`INSERT INTO shifts (id, seed, starts_at, ends_at, status) VALUES ($1, $2, $3, $4, 'open')`, [shiftIndex, seed, iso(s.shiftStart), iso(s.shiftStart + SHIFT_HOURS * 3_600_000)])
  for (const i of s.inbound) {
    await client.query(`INSERT INTO inbound_trains (id, shift_id, symbol, scheduled_arrival, eta) VALUES ($1, $2, $3, $4, $4)`, [i.id, shiftIndex, i.symbol, iso(i.scheduledArrival)])
  }
  for (const o of s.outbound) {
    await client.query(`INSERT INTO outbound_trains (id, shift_id, symbol, scheduled_departure, block_sequence, max_length_ft, max_tons, min_cars) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      o.id,
      shiftIndex,
      o.symbol,
      iso(o.scheduledDeparture),
      o.blockSequence,
      o.maxLengthFt,
      o.maxTons,
      o.minCars,
    ])
  }
  for (const c of s.cars) {
    await client.query(`INSERT INTO cars (id, shift_id, length_ft, tons, block_id, hazmat_class, inbound_id, consist_pos, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'inbound')`, [
      c.id,
      shiftIndex,
      c.lengthFt,
      c.tons,
      c.blockId,
      c.hazmatClass,
      c.inboundId,
      c.consistPos,
    ])
  }
}

export interface LoadOptions {
  seed: number
  plannerSettings?: Record<string, unknown>
  autoPublish?: boolean
}

/** Wipes operations and starts shift 1 from the seed. Queues the first solve. */
export async function resetYard(client: pg.PoolClient, options: LoadOptions): Promise<string> {
  await clearOperational(client)
  await insertLayout(client)
  await insertShift(client, options.seed, 1)
  await client.query(`INSERT INTO yard_state (yard_id, shift_id, seed, sim_now, rules, planner_settings, auto_publish) VALUES ($1, 1, $2, $3, $4, $5, $6)`, [
    YARD_ID,
    options.seed,
    new Date(shiftStart(1)).toISOString(),
    JSON.stringify(DEFAULT_RULES),
    JSON.stringify(options.plannerSettings ?? {}),
    options.autoPublish ?? true,
  ])
  await client.query(`INSERT INTO yard_state_log (version, shift_id, kind, detail, actor, sim_at) VALUES (1, 1, 'shift_loaded', $1, 'seed', $2)`, [JSON.stringify({ seed: options.seed }), new Date(shiftStart(1)).toISOString()])
  return enqueueInitial(client, 1, options.seed, options.plannerSettings)
}

export function enqueueInitial(client: pg.PoolClient, shiftId: number, seed: number, settings?: Record<string, unknown>): Promise<string> {
  return enqueueSolve(client, {
    shiftId,
    purpose: 'initial',
    algorithm: 'local_search',
    reason: `first plan for shift ${shiftId}`,
    timeLimitMs: (settings?.timeLimitMs as number) ?? config.planner.defaultTimeLimitMs,
    iterationLimit: (settings?.iterations as number) ?? config.planner.defaultIterations,
    seed: hash32(`initial|${seed}|${shiftId}`) % 2_000_000_000,
  })
}

/** Closes the shift and opens the next. Cars still in the yard stay on their tracks and get planned onto the next shift's trains. */
export async function rollShift(client: pg.PoolClient, summary: unknown): Promise<number> {
  const { rows } = await client.query(`SELECT shift_id, seed, planner_settings FROM yard_state FOR UPDATE`)
  const { shift_id: shiftId, seed, planner_settings: settings } = rows[0]
  const next = Number(shiftId) + 1
  await client.query(`UPDATE shifts SET status = 'closed', closed_at = now(), summary = $2 WHERE id = $1`, [shiftId, JSON.stringify(summary)])
  await client.query(`UPDATE locks SET active = FALSE, released_by = 'shift change', released_reason = 'shift closed', released_at = now() WHERE active`)
  await client.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE status <> 'resolved' AND shift_id = $1`, [shiftId])
  await client.query(`UPDATE blocks SET override_track_ids = '{}'`)
  await insertShift(client, seed, next)
  await client.query(`UPDATE switch_lists SET status = 'superseded', superseded_at = now() WHERE shift_id = $1 AND status IN ('draft', 'published')`, [shiftId])
  const start = new Date(shiftStart(next)).toISOString()
  const { rows: v } = await client.query(`UPDATE yard_state SET shift_id = $1, head_version_id = NULL, working_version_id = NULL, sim_now = GREATEST(sim_now, $2::timestamptz), state_version = state_version + 1 RETURNING state_version`, [next, start])
  await client.query(`INSERT INTO yard_state_log (version, shift_id, kind, detail, actor, sim_at) VALUES ($1, $2, 'shift_loaded', $3, 'shift change', $4)`, [v[0].state_version, next, JSON.stringify({ seed }), start])
  await enqueueInitial(client, next, seed, settings)
  return next
}
