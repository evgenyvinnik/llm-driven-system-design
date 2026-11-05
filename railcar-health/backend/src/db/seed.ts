/**
 * Seeds reference data, users and history. Rerunnable: it wipes and reseeds.
 *
 * History is seeded directly (it would take days of simulation to accumulate):
 *  - two earlier trips of NRLX 220187, whose L2 bearing ran warm on both, so the
 *    car view shows a cross-trip trend and the LOW-by-history rule has evidence;
 *  - ~45 closed, inspected alerts across tiers with their features and findings,
 *    plus a few defects found on routine inspection with no alert. These are the
 *    labels behind the admin page's precision/recall and threshold backtest.
 *    They are illustrative demo data, not real-world rates.
 */
import bcrypt from 'bcryptjs'
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { DEFAULT_THRESHOLDS, TIER_ACTION, type CarEnd, type Direction } from '../shared/domain.js'
import { detectorViewOf } from '../shared/geometry.js'
import { DESKS, DETECTORS, SUBDIVISIONS, YARDS } from '../shared/network.js'
import { OWNERS } from '../simulator/fleet.js'
import { gaussian, mulberry32 } from '../simulator/rng.js'

const rng = mulberry32(2026)
const DAY = 86_400_000
const now = Date.now()
const round1 = (n: number) => Math.round(n * 10) / 10

const USERS = [
  { username: 'alice', name: 'Alice Moreno', role: 'dispatcher', desk: 'WEST', yard: null },
  { username: 'dan', name: 'Dan Okafor', role: 'dispatcher', desk: 'EAST', yard: null },
  { username: 'bob', name: 'Bob Lindqvist', role: 'yard', desk: null, yard: 'CDJ' },
  { username: 'erin', name: 'Erin Walsh', role: 'yard', desk: null, yard: 'RDG' },
  { username: 'carol', name: 'Carol Nguyen', role: 'admin', desk: null, yard: null },
] as const

async function reset(client: { query: typeof pool.query }): Promise<void> {
  await client.query(`TRUNCATE notifications, findings, work_orders, car_holds, alert_events, alerts, threshold_changes, thresholds,
    bearing_trip_summary, detector_bias_samples, expected_passes, axle_readings, detector_passes, trip_events, trip_units, trips,
    railcars, users, detectors, yards, subdivisions, dispatcher_desks RESTART IDENTITY CASCADE`)
}

async function seedReference(client: { query: typeof pool.query }): Promise<void> {
  for (const d of DESKS) await client.query('INSERT INTO dispatcher_desks (id, name) VALUES ($1, $2)', [d.id, d.name])
  for (const s of SUBDIVISIONS) {
    await client.query('INSERT INTO subdivisions (id, name, start_mp, end_mp, desk_id) VALUES ($1, $2, $3, $4, $5)', [s.id, s.name, s.startMp, Math.floor(s.endMp), s.deskId])
  }
  for (const y of YARDS) await client.query('INSERT INTO yards (id, name, milepost, subdivision_id) VALUES ($1, $2, $3, $4)', [y.id, y.name, y.milepost, y.subdivisionId])
  for (const d of DETECTORS) {
    await client.query(
      `INSERT INTO detectors (id, name, milepost, subdivision_id, has_aei, braking_zone, gateway_id, last_heard_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.id, d.name, d.milepost, d.subdivisionId, d.hasAei, d.brakingZone, d.gatewayId, new Date(now)],
    )
  }
  const hash = await bcrypt.hash('password123', 10)
  for (const u of USERS) {
    await client.query('INSERT INTO users (username, display_name, password_hash, role, desk_id, yard_id) VALUES ($1, $2, $3, $4, $5, $6)', [
      u.username, u.name, hash, u.role, u.desk, u.yard,
    ])
  }
  await client.query('INSERT INTO thresholds (id, config, version, updated_by) VALUES (1, $1, 1, $2)', [DEFAULT_THRESHOLDS, 'seed'])
  await client.query('INSERT INTO threshold_changes (version, config, changed_by) VALUES (1, $1, $2)', [DEFAULT_THRESHOLDS, 'seed'])
}

async function insertCar(client: { query: typeof pool.query }, carId: string): Promise<void> {
  const owner = OWNERS.find((o) => carId.startsWith(o.mark)) ?? OWNERS[0]
  await client.query('INSERT INTO railcars (car_id, owner_mark, owner_name, car_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [carId, owner.mark, owner.name, owner.carType])
}

async function insertTrip(
  client: { query: typeof pool.query },
  t: { tripId: string; symbol: string; direction: Direction; origin: string; destination: string; departedAt: Date; arrivedAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO trips (trip_id, symbol, direction, origin_yard_id, destination_yard_id, stops, status, departed_at, arrived_at, arrived_yard_id, speed_mph, territory_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'arrived', $7, $8, $5, 45, (SELECT subdivision_id FROM yards WHERE id = $5))`,
    [t.tripId, t.symbol, t.direction, t.origin, t.destination, [t.destination], t.departedAt, t.arrivedAt],
  )
}

/** Two earlier trips of NRLX 220187 with readings for its eight bearings; L2 runs ~17°F warm. */
async function seedCarHistory(client: { query: typeof pool.query }): Promise<void> {
  const carId = 'NRLX 220187'
  await insertCar(client, carId)
  const trips: Array<{ tripId: string; symbol: string; direction: Direction; origin: string; destination: string; daysAgo: number; leadingEnd: CarEnd }> = [
    { tripId: 'M-HARRID-H1', symbol: 'M-HARRID', direction: 'EB', origin: 'HAR', destination: 'RDG', daysAgo: 6, leadingEnd: 'B' },
    // Same physical orientation (B-end east), now moving west: the A-end leads.
    { tripId: 'M-RIDHAR-H2', symbol: 'M-RIDHAR', direction: 'WB', origin: 'RDG', destination: 'HAR', daysAgo: 3, leadingEnd: 'A' },
  ]
  const position = 30
  const firstSeq = 12 + (position - 3) * 4 + 1 // two 6-axle locomotives, then cars
  for (const t of trips) {
    const departedAt = new Date(now - t.daysAgo * DAY)
    await insertTrip(client, { ...t, departedAt, arrivedAt: new Date(departedAt.getTime() + 6 * 3_600_000) })
    await client.query(`INSERT INTO trip_units (trip_id, position, unit_id, unit_type, axle_count, leading_end) VALUES ($1, $2, $3, 'car', 4, $4)`, [
      t.tripId, position, carId, t.leadingEnd,
    ])
    const route = DETECTORS.filter((d) => d.id !== 'HBD-170').sort((a, b) => (t.direction === 'EB' ? a.milepost - b.milepost : b.milepost - a.milepost))
    const deltas: number[] = []
    for (const [i, d] of route.entries()) {
      const passedAt = new Date(departedAt.getTime() + (i + 1) * 20 * 60_000)
      const ambient = round1(55 + gaussian(rng) * 3)
      const median = round1(ambient + 40)
      const passId = `H${passedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`
      await client.query(
        `INSERT INTO detector_passes (detector_id, pass_id, trip_id, gateway_id, direction, passed_at, sent_at, received_at, speed_mph, ambient_f, axle_count,
                                      identity_status, median_bearing_n, median_bearing_s, median_wheel_n, median_wheel_s, payload_sha, published_at, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 45, $7, 292, 'resolved', $8, $8, $9, $9, 'seed', now(), now())`,
        [d.id, passId, t.tripId, d.gatewayId, t.direction, passedAt, ambient, median, round1(ambient + 12)],
      )
      for (const side of ['L', 'R'] as const) {
        for (let axle = 1; axle <= 4; axle++) {
          const view = detectorViewOf(side, axle, t.direction, t.leadingEnd, 4)
          const delta = side === 'L' && axle === 2 ? 17 + gaussian(rng) * 3 : gaussian(rng) * 3
          if (side === 'L' && axle === 2) deltas.push(delta)
          await client.query(
            `INSERT INTO axle_readings (detector_id, pass_id, axle_seq, rail, bearing_f, wheel_f, car_id, unit_position, car_axle, car_side)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [d.id, passId, firstSeq + view.seqInCar - 1, view.rail, round1(median + delta), round1(ambient + 12 + gaussian(rng) * 5), carId, position, axle, side],
          )
        }
      }
    }
    const sorted = [...deltas].sort((a, b) => a - b)
    await client.query(
      `INSERT INTO bearing_trip_summary (car_id, kind, position, trip_id, observations, median_side_delta, max_side_delta, max_above_ambient, elevated, last_seen_at)
       VALUES ($1, 'hot_bearing', 'L2', $2, $3, $4, $5, $6, true, $7)`,
      [carId, t.tripId, deltas.length, round1(sorted[Math.floor(sorted.length / 2)]), round1(sorted[sorted.length - 1]), round1(40 + sorted[sorted.length - 1]),
        new Date(departedAt.getTime() + 6 * 3_600_000)],
    )
  }
}

interface HistAlert {
  tier: number
  kind: 'hot_bearing' | 'hot_wheel'
  features: Record<string, number | boolean | string | null>
  defect: boolean
}

/** Illustrative labeled history. Within each tier, stronger evidence is more often a real defect. */
function historicalAlerts(): HistAlert[] {
  const out: HistAlert[] = []
  const make = (tier: number, count: number, gen: (i: number) => Record<string, number | boolean | string | null>, defects: number, kind: HistAlert['kind'] = 'hot_bearing') => {
    const rows = Array.from({ length: count }, (_, i) => gen(i))
    const strength = (f: Record<string, unknown>) => Number(kind === 'hot_wheel' ? f.wheelDelta : f.sideDelta) + gaussian(rng) * 4
    rows
      .map((f) => ({ f, s: strength(f) }))
      .sort((a, b) => b.s - a.s)
      .forEach(({ f }, i) => out.push({ tier, kind, features: f, defect: i < defects }))
  }
  const base = (o: Record<string, number | boolean | null>) => ({ percentile: 99.8, maxGapMiles: 15, coverageGap: false, biasCorrected: false, historyElevatedTrips: 0, wheelDelta: 4, wheelConsecutiveHot: 0, edgeAlarm: false, lastDetectorId: 'HBD-155', ...o })
  const u = (lo: number, hi: number) => round1(lo + rng() * (hi - lo))
  make(4, 5, (i) => { const sd = u(125, 175); return base({ observations: 8, aboveAmbient: u(197, 230), sideDelta: sd, maxSideDelta: sd, medianSideDelta: u(60, 90), risePer15mi: u(10, 20), consecutiveElevated: 6, edgeAlarm: i % 2 === 0 }) }, 4)
  make(3, 10, () => { const sd = u(60, 98); return base({ observations: 6, aboveAmbient: u(105, 148), sideDelta: sd, maxSideDelta: sd, medianSideDelta: u(35, 55), risePer15mi: u(8, 15), consecutiveElevated: 4 }) }, 7)
  make(2, 16, () => { const sd = u(36, 58); return base({ observations: 5, aboveAmbient: u(70, 100), sideDelta: sd, maxSideDelta: sd, medianSideDelta: u(25, 40), risePer15mi: u(1, 5.5), consecutiveElevated: 3 }) }, 8)
  make(1, 14, () => { const sd = u(20, 31); return base({ observations: 5, aboveAmbient: u(55, 72), sideDelta: sd, maxSideDelta: sd, medianSideDelta: u(16, 24), risePer15mi: u(0, 4), consecutiveElevated: 2, percentile: 99.5 }) }, 3)
  make(2, 3, () => base({ observations: 4, aboveAmbient: 60, sideDelta: 8, maxSideDelta: 10, medianSideDelta: 6, risePer15mi: 0, consecutiveElevated: 0, wheelDelta: u(160, 240), wheelConsecutiveHot: 3 }), 2, 'hot_wheel')
  return out
}

async function seedLabeledHistory(client: { query: typeof pool.query }): Promise<{ alerts: number; routine: number }> {
  const alerts = historicalAlerts()
  const yards = ['CDJ', 'RDG', 'HAR']
  let carSerial = 0
  for (const [i, a] of alerts.entries()) {
    const owner = OWNERS[i % OWNERS.length]
    const carId = `${owner.mark} ${(700000 + (carSerial += 137)).toString()}`
    await insertCar(client, carId)
    const daysAgo = 2 + (i * 53) / alerts.length
    const departedAt = new Date(now - daysAgo * DAY)
    const eb = i % 2 === 0
    const tripId = `HIST-${String(i + 1).padStart(3, '0')}`
    const yardId = yards[i % yards.length]
    await insertTrip(client, { tripId, symbol: eb ? 'M-HARRID' : 'M-RIDHAR', direction: eb ? 'EB' : 'WB', origin: eb ? 'HAR' : 'RDG', destination: eb ? 'RDG' : 'HAR', departedAt, arrivedAt: new Date(departedAt.getTime() + 6 * 3_600_000) })
    const position = `${i % 3 === 0 ? 'L' : 'R'}${(i % 4) + 1}`
    const openedAt = new Date(departedAt.getTime() + 2 * 3_600_000)
    const closedAt = new Date(openedAt.getTime() + 3 * 3_600_000)
    const finding = a.defect ? (a.kind === 'hot_wheel' ? 'wheel_defect' : 'confirmed_bearing_defect') : 'no_defect_found'
    const disposition = a.defect ? 'bad_order' : 'release'
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO alerts (trip_id, car_id, kind, position, tier, status, action, routing, yard_id, reasons, features, route_note, data_lag_seconds,
                           late, opened_at, updated_at, closed_at, outcome, version)
       VALUES ($1, $2, $3, $4, $5, 'closed', $6, 'yard', $7, $8, $9, 'Seeded history', 60, false, $10, $11, $11, $12, 3) RETURNING id`,
      [tripId, carId, a.kind, position, a.tier, TIER_ACTION[a.tier], yardId, JSON.stringify(['Seeded historical alert']), a.features, openedAt, closedAt, finding],
    )
    const alertId = rows[0].id
    const wo = await client.query<{ id: string }>(
      `INSERT INTO work_orders (alert_id, car_id, position, kind, yard_id, priority, status, assigned_to, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $8, $9) RETURNING id`,
      [alertId, carId, position, a.kind, yardId, a.tier, yardId === 'CDJ' ? 'bob' : 'erin', openedAt, closedAt],
    )
    await client.query(
      `INSERT INTO car_holds (car_id, alert_id, yard_id, status, reason, created_at, released_at, released_by) VALUES ($1, $2, $3, $4, 'Seeded history', $5, $6, 'seed')`,
      [carId, alertId, yardId, a.defect ? 'bad_ordered' : 'released', openedAt, a.defect ? null : closedAt],
    )
    await client.query(
      `INSERT INTO findings (client_submission_id, work_order_id, alert_id, car_id, position, source, finding, disposition, recorded_by, observed_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, 'alert', $6, $7, 'seed', $8, $8)`,
      [`seed-${i}`, wo.rows[0].id, alertId, carId, position, finding, disposition, closedAt],
    )
    await client.query(`INSERT INTO alert_events (alert_id, kind, tier, note, actor, at) VALUES ($1, 'opened', $2, 'Seeded history', 'seed', $3), ($1, 'closed', NULL, $4, 'seed', $5)`, [
      alertId, a.tier, openedAt, finding, closedAt,
    ])
  }
  // Defects found on routine inspection with no prior alert: the misses that make recall < 100%.
  const routine = 3
  for (let i = 0; i < routine; i++) {
    const carId = `HPRX ${(810000 + i * 77).toString()}`
    await insertCar(client, carId)
    const at = new Date(now - (5 + i * 9) * DAY)
    await client.query(
      `INSERT INTO findings (client_submission_id, car_id, position, source, finding, disposition, notes, recorded_by, observed_at, recorded_at)
       VALUES ($1, $2, 'R2', 'routine', 'confirmed_bearing_defect', 'bad_order', 'Found on routine inspection; no prior alert', 'seed', $3, $3)`,
      [`seed-routine-${i}`, carId, at],
    )
  }
  return { alerts: alerts.length, routine }
}

async function main(): Promise<void> {
  try {
    const counts = await withTransaction(async (client) => {
      await reset(client)
      await seedReference(client)
      await seedCarHistory(client)
      return seedLabeledHistory(client)
    })
    // Old stream pointers and the old simulation clock refer to data that no longer exists.
    await redis.del(config.stream.key, config.stream.deadLetterKey, config.clockKey)
    console.log(`Seeded ${DETECTORS.length} detectors, ${YARDS.length} yards, ${USERS.length} users, NRLX 220187 history, ${counts.alerts} labeled alerts, ${counts.routine} routine findings`)
    console.log('Users (password "password123"): alice, dan (dispatchers), bob (Cedar Jct yard), erin (Ridgeway yard), carol (reliability admin)')
  } catch (err) {
    console.error('Seed failed:', err)
    process.exitCode = 1
  } finally {
    await pool.end()
    redis.disconnect()
  }
}

await main()
