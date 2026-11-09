/**
 * Per-shift metrics, computed from raw rows on demand. Nothing is pre-aggregated,
 * so there's no second number to disagree with the rows. The e2e recomputes the
 * same figures with its own SQL.
 * @module metrics/shift
 */
import type { Queryable } from '../shared/db.js'

const ON_TIME_TOLERANCE_MIN = 15

export interface ShiftMetrics {
  shiftId: number
  status: string
  startsAt: string
  endsAt: string
  trainsDue: number
  departedOnTime: number
  departedLate: number
  missed: number
  onTimePct: number | null
  carsHandled: number
  handlings: number
  movesPerCar: number | null
  carsDeparted: number
  avgDwellHours: number | null
  carsOnHand: number | null
  capacityViolations: number
  overrides: number
  refusedOverrides: number
  plannedMoves: number
  overrideRatePer100Moves: number | null
  overrideReasons: Record<string, number>
  planVersions: number
  replans: number
  crewReports: number
  crewExceptions: number
}

export async function shiftMetrics(db: Queryable, shiftId: number, simNow: Date | null): Promise<ShiftMetrics | null> {
  const { rows: shiftRows } = await db.query(`SELECT * FROM shifts WHERE id = $1`, [shiftId])
  const shift = shiftRows[0]
  if (!shift) return null
  const at = simNow ?? new Date(shift.ends_at)
  const { rows: trains } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'departed' OR status = 'missed' OR scheduled_departure <= $2)::int AS due,
            count(*) FILTER (WHERE status = 'departed' AND actual_departure <= scheduled_departure + make_interval(mins => $3))::int AS on_time,
            count(*) FILTER (WHERE status = 'departed' AND actual_departure > scheduled_departure + make_interval(mins => $3))::int AS late,
            count(*) FILTER (WHERE status = 'missed' OR (status = 'planned' AND scheduled_departure <= $2))::int AS missed
       FROM outbound_trains WHERE shift_id = $1`,
    [shiftId, at.toISOString(), ON_TIME_TOLERANCE_MIN],
  )
  const { rows: hand } = await db.query(`SELECT count(*)::int AS handlings, count(DISTINCT car_id)::int AS cars FROM car_handlings WHERE shift_id = $1`, [shiftId])
  const { rows: dwell } = await db.query(
    `SELECT count(*)::int AS departed, AVG(EXTRACT(EPOCH FROM departed_at - arrived_at) / 3600) AS hours
       FROM cars c JOIN outbound_trains o ON o.id = c.departed_on WHERE o.shift_id = $1 AND c.arrived_at IS NOT NULL`,
    [shiftId],
  )
  const { rows: onHand } = await db.query(`SELECT count(*)::int AS n FROM cars WHERE position = 'on_track'`)
  const { rows: capacity } = await db.query(`SELECT count(*)::int AS n FROM capacity_events WHERE shift_id = $1`, [shiftId])
  const { rows: overrides } = await db.query(`SELECT count(*) FILTER (WHERE NOT refused)::int AS accepted, count(*) FILTER (WHERE refused)::int AS refused FROM overrides WHERE shift_id = $1`, [shiftId])
  const { rows: reasons } = await db.query(`SELECT reason_code, count(*)::int AS n FROM overrides WHERE shift_id = $1 AND NOT refused GROUP BY reason_code ORDER BY n DESC`, [shiftId])
  const { rows: versions } = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE author_kind = 'planner' AND parent_id IS NOT NULL)::int AS replans FROM switch_lists WHERE shift_id = $1`, [shiftId])
  const { rows: planned } = await db.query(
    `SELECT count(*)::int AS n FROM moves WHERE list_id = (SELECT id FROM switch_lists WHERE shift_id = $1 AND published_at IS NOT NULL ORDER BY version_no DESC LIMIT 1) AND kind <> 'receive'`,
    [shiftId],
  )
  const { rows: reports } = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE kind = 'exception')::int AS exceptions FROM crew_reports WHERE shift_id = $1`, [shiftId])
  const t = trains[0]
  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d
  const accepted = overrides[0].accepted as number
  const plannedMoves = planned[0].n as number
  return {
    shiftId,
    status: shift.status,
    startsAt: new Date(shift.starts_at).toISOString(),
    endsAt: new Date(shift.ends_at).toISOString(),
    trainsDue: t.due,
    departedOnTime: t.on_time,
    departedLate: t.late,
    missed: t.missed,
    onTimePct: t.due > 0 ? round((t.on_time / t.due) * 100, 1) : null,
    carsHandled: hand[0].cars,
    handlings: hand[0].handlings,
    movesPerCar: hand[0].cars > 0 ? round(hand[0].handlings / hand[0].cars) : null,
    carsDeparted: dwell[0].departed,
    avgDwellHours: dwell[0].hours === null ? null : round(Number(dwell[0].hours)),
    carsOnHand: shift.status === 'open' ? onHand[0].n : null,
    capacityViolations: capacity[0].n,
    overrides: accepted,
    refusedOverrides: overrides[0].refused,
    plannedMoves,
    overrideRatePer100Moves: plannedMoves > 0 ? round((accepted / plannedMoves) * 100, 1) : null,
    overrideReasons: Object.fromEntries(reasons.map((r) => [r.reason_code, r.n])),
    planVersions: versions[0].n,
    replans: versions[0].replans,
    crewReports: reports[0].n,
    crewExceptions: reports[0].exceptions,
  }
}
