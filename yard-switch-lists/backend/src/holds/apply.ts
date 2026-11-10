/**
 * Consumes the hold feed from railcar-health (#19). The envelope is the one in
 * railcar-health/events.md; running #19 isn't required, because the simulator
 * produces the same events.
 *
 * Delivery is at-least-once and order isn't guaranteed (a redrive from the
 * dead-letter stream can replay old events behind new ones), so:
 *   - event_id dedupes redelivery
 *   - each hold is a register folded by stream_version: an event older than the
 *     register's version is recorded and ignored, so a Released delivered before
 *     its Placed still ends released
 * A car is held if any hold on it is active. Two cases can hold one car, and
 * releasing one leaves the other in force.
 * @module holds/apply
 */
import { z } from 'zod'
import type pg from 'pg'
import { holdEvents } from '../shared/metrics.js'
import { YARD_ID, raiseAlert, readYard, resolveAlert, surprise } from '../plans/state.js'

const iso = z.string().datetime({ offset: true })

/** The envelope from railcar-health/events.md. Unknown fields are kept, not rejected. */
export const holdEnvelope = z
  .object({
    event_id: z.string().min(1),
    type: z.string().min(1),
    version: z.number().int().min(1),
    stream_id: z.string().min(1),
    stream_type: z.string().optional(),
    stream_version: z.number().int().min(1),
    global_position: z.number().int().optional(),
    family: z.string().optional(),
    partition_key: z.string().optional(),
    occurred_at: iso,
    recorded_at: iso.optional(),
    committed_at: iso.optional(),
    correlation_id: z.string().optional(),
    causation_id: z.string().nullable().optional(),
    actor: z.string().optional(),
    tags: z.array(z.string()).optional(),
    payload: z.record(z.unknown()),
  })
  .passthrough()

export type HoldEnvelope = z.infer<typeof holdEnvelope>

const placed = z.object({ holdId: z.string(), carId: z.string(), yardId: z.string().nullable().optional(), reason: z.string().optional(), status: z.enum(['active', 'bad_ordered']).default('active') })
const released = z.object({ holdId: z.string(), carId: z.string(), yardId: z.string().nullable().optional(), by: z.string().optional(), reason: z.string().optional() })
const moved = z.object({ holdId: z.string(), carId: z.string(), fromYardId: z.string().nullable().optional(), toYardId: z.string().nullable().optional(), note: z.string().optional() })

export type HoldOutcome = 'applied' | 'duplicate' | 'stale' | 'other_yard' | 'ignored_type'

export interface HoldResult {
  eventId: string
  outcome: HoldOutcome
  carId: string | null
  held: boolean | null
  replanQueued: boolean
  alert: string | null
}

async function carHeld(client: pg.PoolClient, carId: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM car_holds WHERE car_id = $1 AND status IN ('active', 'bad_ordered') LIMIT 1`, [carId])
  return rows.length > 0
}

/** Applies one event in the caller's transaction. Safe to call any number of times, in any order. */
export async function applyHoldEvent(client: pg.PoolClient, raw: unknown, via: string): Promise<HoldResult> {
  const env = holdEnvelope.parse(raw)
  await readYard(client, true)
  const payload = env.payload as Record<string, unknown>
  const holdId = typeof payload.holdId === 'string' ? payload.holdId : null
  const carId = typeof payload.carId === 'string' ? payload.carId : null
  const record = async (outcome: HoldOutcome) => {
    const { rowCount } = await client.query(
      `INSERT INTO hold_events (event_id, type, version, stream_id, stream_version, occurred_at, hold_id, car_id, envelope, outcome, via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (event_id) DO NOTHING`,
      [env.event_id, env.type, env.version, env.stream_id, env.stream_version, env.occurred_at, holdId, carId, JSON.stringify(env), outcome, via],
    )
    holdEvents.inc({ type: env.type, outcome: rowCount ? outcome : 'duplicate' })
    return (rowCount ?? 0) > 0
  }
  const { rows: seen } = await client.query(`SELECT outcome FROM hold_events WHERE event_id = $1`, [env.event_id])
  if (seen[0]) {
    holdEvents.inc({ type: env.type, outcome: 'duplicate' })
    return { eventId: env.event_id, outcome: 'duplicate', carId, held: carId ? await carHeld(client, carId) : null, replanQueued: false, alert: null }
  }

  let next: { status: string; yardId: string | null; reason: string | null; by: string | null }
  if (env.type === 'CarHoldPlaced') {
    const p = placed.parse(payload)
    if (p.yardId && p.yardId !== YARD_ID) {
      await record('other_yard')
      return { eventId: env.event_id, outcome: 'other_yard', carId, held: null, replanQueued: false, alert: null }
    }
    next = { status: p.status, yardId: p.yardId ?? YARD_ID, reason: p.reason ?? null, by: env.actor ?? null }
  } else if (env.type === 'CarHoldReleased') {
    const p = released.parse(payload)
    next = { status: 'released', yardId: p.yardId ?? YARD_ID, reason: p.reason ?? null, by: p.by ?? env.actor ?? null }
  } else if (env.type === 'CarHoldMoved') {
    const p = moved.parse(payload)
    next = p.toYardId === YARD_ID ? { status: 'active', yardId: YARD_ID, reason: p.note ?? 'hold moved to this yard', by: env.actor ?? null } : { status: 'moved_away', yardId: p.toYardId ?? null, reason: p.note ?? null, by: env.actor ?? null }
  } else {
    await record('ignored_type')
    return { eventId: env.event_id, outcome: 'ignored_type', carId, held: null, replanQueued: false, alert: null }
  }
  if (!holdId || !carId) throw new Error('hold event without holdId or carId')

  const wasHeld = await carHeld(client, carId)
  const { rows: applied } = await client.query(
    `INSERT INTO car_holds (hold_id, car_id, yard_id, status, reason, stream_id, stream_version, placed_at, released_at, released_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 IN ('active', 'bad_ordered') THEN $8::timestamptz END, CASE WHEN $4 = 'released' THEN $8::timestamptz END, CASE WHEN $4 = 'released' THEN $9 END)
     ON CONFLICT (hold_id) DO UPDATE SET status = EXCLUDED.status, yard_id = EXCLUDED.yard_id,
       reason = COALESCE(EXCLUDED.reason, car_holds.reason), stream_version = EXCLUDED.stream_version,
       placed_at = COALESCE(EXCLUDED.placed_at, car_holds.placed_at), released_at = EXCLUDED.released_at, released_by = EXCLUDED.released_by, updated_at = now()
     WHERE car_holds.stream_version < EXCLUDED.stream_version
     RETURNING hold_id`,
    [holdId, carId, next.yardId, next.status, next.reason, env.stream_id, env.stream_version, env.occurred_at, next.by],
  )
  if (applied.length === 0) {
    await record('stale')
    return { eventId: env.event_id, outcome: 'stale', carId, held: await carHeld(client, carId), replanQueued: false, alert: null }
  }
  await record('applied')
  const isHeld = await carHeld(client, carId)
  if (isHeld === wasHeld) return { eventId: env.event_id, outcome: 'applied', carId, held: isHeld, replanQueued: false, alert: null }

  const { rows: carRows } = await client.query(`SELECT position, coupled_to, track_id FROM cars WHERE id = $1`, [carId])
  const car = carRows[0]
  let alert: string | null = null
  let replanQueued = false
  if (isHeld) {
    if (car) {
      const { rows: train } = car.coupled_to ? await client.query(`SELECT symbol, status FROM outbound_trains WHERE id = $1`, [car.coupled_to]) : { rows: [] }
      if (car.position === 'departed') {
        alert = 'hold_after_departure'
        await raiseAlert(client, { dedupKey: `hold:${holdId}:departed`, kind: alert, severity: 'critical', carId, message: `Hold placed on ${carId}, which has already left this yard. The next yard must stop it.` })
      } else {
        await surprise(client, 'hold_placed', { holdId, carId }, env.actor ?? 'railcar-health')
        replanQueued = true
        if (car.coupled_to && train[0]) {
          alert = 'hold_after_coupling'
          await raiseAlert(client, {
            dedupKey: `hold:${holdId}:coupled`,
            kind: alert,
            severity: 'critical',
            carId,
            outboundId: car.coupled_to,
            message: `Hold placed on ${carId} after it was coupled to ${train[0].symbol} on ${car.track_id}. The train can't leave until the car is set out.`,
          })
        } else {
          const { rows: moving } = await client.query(
            `SELECT key FROM move_executions e WHERE e.status = 'in_progress' AND e.shift_id = (SELECT shift_id FROM yard_state LIMIT 1) AND e.move -> 'carIds' ? $1`,
            [carId],
          )
          if (moving[0]) {
            alert = 'hold_during_move'
            await raiseAlert(client, { dedupKey: `hold:${holdId}:moving`, kind: alert, severity: 'critical', carId, moveKey: moving[0].key, message: `Hold placed on ${carId} while move ${moving[0].key} is in progress. Tell the crew to stop.` })
          }
        }
      }
    }
  } else {
    await resolveAlert(client, `hold:${holdId}:coupled`)
    await resolveAlert(client, `hold:${holdId}:moving`)
    if (car && car.position !== 'departed') {
      await surprise(client, 'hold_released', { holdId, carId }, env.actor ?? 'railcar-health')
      replanQueued = true
    }
  }
  return { eventId: env.event_id, outcome: 'applied', carId, held: isHeld, replanQueued, alert }
}

/** Builds an event in the #19 envelope. Used by the simulated producer and the tests. */
export function makeHoldEvent(args: {
  eventId: string
  type: 'CarHoldPlaced' | 'CarHoldReleased' | 'CarHoldMoved'
  holdId: string
  carId: string
  caseId: string
  streamVersion: number
  occurredAt: string
  yardId?: string
  reason?: string
  status?: 'active' | 'bad_ordered'
  by?: string
}): HoldEnvelope {
  const yardId = args.yardId ?? YARD_ID
  const payload: Record<string, unknown> =
    args.type === 'CarHoldPlaced'
      ? { holdId: args.holdId, carId: args.carId, yardId, reason: args.reason ?? 'hot bearing trend', status: args.status ?? 'active' }
      : args.type === 'CarHoldReleased'
        ? { holdId: args.holdId, carId: args.carId, yardId, by: args.by ?? 'inspector', reason: args.reason ?? 'released' }
        : { holdId: args.holdId, carId: args.carId, fromYardId: 'ELSEWHERE', toYardId: yardId, note: args.reason ?? 'car passed its yard uninspected' }
  return {
    event_id: args.eventId,
    type: args.type,
    version: 1,
    stream_id: `case-${args.caseId}`,
    stream_type: 'case',
    stream_version: args.streamVersion,
    family: 'cases',
    partition_key: args.caseId,
    occurred_at: args.occurredAt,
    recorded_at: args.occurredAt,
    committed_at: args.occurredAt,
    correlation_id: `case:${args.caseId}`,
    causation_id: null,
    actor: 'railcar-health',
    tags: [`car:${args.carId}`, `case:${args.caseId}`],
    payload,
  }
}
