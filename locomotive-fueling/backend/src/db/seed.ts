/**
 * Seeds the demo network, fleet and users, and the starting latest state in
 * Valkey, so the fleet board and first plans exist before the simulator sends
 * a single reading. Rerunnable: it truncates every table and deletes this
 * project's Valkey keys first. Stop the services before reseeding.
 *
 * Users (password123): alice (fuel desk), bob (crew on S-KCKBAR), carol (admin).
 */
import bcrypt from 'bcryptjs'
import { buildLegs, nodeMileposts } from '../domain/consumption.js'
import { FUEL_OPTIONS, LOCATIONS, LOCO_MODELS, ROUTES, TRACKS, TRAINS } from '../domain/network.js'
import { keys, redis } from '../shared/cache.js'
import { pool, withTransaction } from '../shared/db.js'
import { writeClock } from '../shared/sim-clock.js'
import { writeStateGuarded } from '../shared/state.js'
import { enqueuePlan } from '../shared/triggers.js'

const USERS = [
  { id: 'u_alice', username: 'alice', name: 'Alice Romero', role: 'fuel_desk', trainId: null },
  { id: 'u_bob', username: 'bob', name: 'Bob Tanaka', role: 'crew', trainId: 'T03' },
  { id: 'u_carol', username: 'carol', name: 'Carol Davis', role: 'admin', trainId: null },
] as const

const SPARES = [
  { id: '4700', model: 'AC4400CW' },
  { id: '7400', model: 'ET44C4' },
] as const

async function clearValkey(): Promise<number> {
  let cursor = '0'
  let removed = 0
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', keys.pattern, 'COUNT', 500)
    cursor = next
    if (found.length) removed += await redis.del(...found)
  } while (cursor !== '0')
  return removed
}

async function seed(): Promise<void> {
  const simMs = Math.floor(Date.now() / 60_000) * 60_000
  const hash = await bcrypt.hash('password123', 10)

  await withTransaction(async (db) => {
    await db.query(`TRUNCATE users, locations, tracks, routes, fuel_options, fuel_price_history, locomotives, trains, consist_units, telemetry,
                    fueling_events, fuel_plans, plan_stops, stop_commitments, plan_evaluations, dtl_orders, dtl_order_events, fuel_tickets, alerts, model_params CASCADE`)
    for (const l of LOCATIONS) await db.query('INSERT INTO locations (id, name, state, lat, lon) VALUES ($1, $2, $3, $4, $5)', [l.id, l.name, l.state, l.lat, l.lon])
    for (const t of TRACKS) {
      await db.query('INSERT INTO tracks (a, b, miles, rise_ab, rise_ba, curve_lb_per_ton, speed_mph, dark) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        t.a, t.b, t.miles, t.riseAb, t.riseBa, t.curveLbPerTon, t.speedMph, t.dark,
      ])
    }
    for (const r of ROUTES) await db.query('INSERT INTO routes (id, name, path) VALUES ($1, $2, $3)', [r.id, r.name, r.path])
    for (const o of FUEL_OPTIONS) {
      await db.query(
        `INSERT INTO fuel_options (id, location_id, kind, vendor, price_per_gal, fee, setup_minutes, pump_gpm, lead_time_hours, cancel_fee, bays)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [o.id, o.locationId, o.kind, o.vendor, o.pricePerGal, o.fee, o.setupMinutes, o.pumpGpm, o.leadTimeHours, o.cancelFee, o.bays],
      )
      await db.query(`INSERT INTO fuel_price_history (option_id, price_per_gal, effective_at, changed_by, note) VALUES ($1, $2, $3, 'seed', 'Contract price')`, [
        o.id, o.pricePerGal, new Date(simMs),
      ])
    }
    const units = [...TRAINS.flatMap((t) => t.units.map((u) => ({ id: u.id, model: u.model }))), ...SPARES]
    for (const u of units) {
      const m = LOCO_MODELS[u.model]
      await db.query('INSERT INTO locomotives (id, model, horsepower, tank_gal, model_factor) VALUES ($1, $2, $3, $4, $5)', [u.id, m.model, m.horsepower, m.tankGal, m.modelFactor])
    }
    for (const t of TRAINS) {
      const route = ROUTES.find((r) => r.id === t.routeId)!
      const nodes = nodeMileposts(buildLegs(route.path, TRACKS))
      const last = [...nodes].reverse().find((n) => n.milepost <= t.startMilepost)
      const departed = new Date(simMs - (t.startMilepost / 45) * 3_600_000)
      await db.query(
        `INSERT INTO trains (id, symbol, route_id, path, planned_tons, cars, departed_at, last_milepost, last_location) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [t.id, t.symbol, t.routeId, route.path, t.plannedTons, t.cars, departed, t.startMilepost, last?.locationId ?? null],
      )
      for (const [i, u] of t.units.entries()) {
        const role = i === 0 ? 'lead' : i === t.units.length - 1 && t.units.length > 2 ? 'dp' : 'trailing'
        await db.query('INSERT INTO consist_units (train_id, locomotive_id, position, role) VALUES ($1, $2, $3, $4)', [t.id, u.id, i + 1, role])
      }
    }
    for (const u of USERS) {
      await db.query('INSERT INTO users (id, username, display_name, role, train_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)', [
        u.id, u.username, u.name, u.role, u.trainId, hash,
      ])
    }
  })

  const removed = await clearValkey()
  await writeClock({ simMs, wallMs: Date.now(), speedup: 1 })

  // Starting latest state, as if each unit had just reported.
  const pipe = redis.pipeline()
  for (const t of TRAINS) {
    for (const u of t.units) {
      const m = LOCO_MODELS[u.model]
      writeStateGuarded(pipe as unknown as { eval: (...args: (string | number)[]) => unknown }, {
        locomotiveId: u.id,
        seq: Math.floor(simMs / 1000) - 60,
        recordedAt: simMs - 60_000,
        trainId: t.id,
        milepost: t.startMilepost,
        speedMph: 0,
        notch: 0,
        engineState: 'idle',
        fuelRaw: Math.round(m.tankGal * u.fuel),
        fuelGal: Math.round(m.tankGal * u.fuel),
        capacityGal: m.tankGal,
        calibration: 1,
        sensorSuspect: false,
        leakSuspect: false,
        lat: 0,
        lon: 0,
      })
    }
  }
  await pipe.exec()
  for (const t of TRAINS) await enqueuePlan(t.id, 'initial')

  console.log(`Seeded ${LOCATIONS.length} locations, ${FUEL_OPTIONS.length} fuel options, ${TRAINS.length} trains, ${USERS.length} users; cleared ${removed} Valkey keys`)
}

try {
  await seed()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
  redis.disconnect()
}
