/**
 * Seeds reference data: shippers, users (password123), yards, AEI sites, trains, the historical dwell
 * distributions and the car registry. Trip plans and every movement come from the simulator through the
 * API, so they are events in the log. Idempotent.
 */
import bcrypt from 'bcryptjs'
import { pool } from '../shared/db.js'
import { DWELL, SHIPPERS, SITES, TRAINS, YARDS } from '../shared/network.js'
import { buildFleet } from '../simulator/fleet.js'

const USERS = [
  { username: 'sam', displayName: 'Sam Ortiz', role: 'shipper', shipperId: 'S01' },
  { username: 'priya', displayName: 'Priya Shah', role: 'shipper', shipperId: 'S09' },
  { username: 'olivia', displayName: 'Olivia Grant', role: 'ops', shipperId: null },
  { username: 'alex', displayName: 'Alex Kim', role: 'admin', shipperId: null },
]

async function seed(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const s of SHIPPERS) {
      await client.query('INSERT INTO shippers (shipper_id, name, contact) VALUES ($1, $2, $3) ON CONFLICT (shipper_id) DO UPDATE SET name = EXCLUDED.name, contact = EXCLUDED.contact', [s.shipperId, s.name, s.contact])
    }
    const hash = await bcrypt.hash('password123', 10)
    for (const u of USERS) {
      await client.query(
        `INSERT INTO users (username, password_hash, display_name, role, shipper_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name, role = EXCLUDED.role, shipper_id = EXCLUDED.shipper_id`,
        [u.username, hash, u.displayName, u.role, u.shipperId],
      )
    }
    for (const y of YARDS) {
      await client.query(
        `INSERT INTO yards (yard_id, name, min_connection_minutes, interchange_road) VALUES ($1, $2, $3, $4)
         ON CONFLICT (yard_id) DO UPDATE SET name = EXCLUDED.name, min_connection_minutes = EXCLUDED.min_connection_minutes, interchange_road = EXCLUDED.interchange_road`,
        [y.yardId, y.name, y.minConnectionMinutes, y.interchangeRoad],
      )
    }
    for (const s of SITES) {
      await client.query(
        `INSERT INTO aei_sites (site_id, name, kind, yard_id, from_yard, to_yard, firmware) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (site_id) DO UPDATE SET firmware = EXCLUDED.firmware`,
        [s.siteId, s.name, s.kind, s.yardId, s.fromYard, s.toYard, s.firmware],
      )
    }
    for (const t of TRAINS) {
      await client.query(
        `INSERT INTO trains (train_id, name, from_yard, to_yard, depart_minute_of_day, run_p50_minutes, run_p90_minutes, capacity, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (train_id) DO NOTHING`,
        [t.trainId, t.name, t.from, t.to, t.departMinute, t.runP50, t.runP90, t.capacity, t.priority],
      )
    }
    for (const d of DWELL) {
      await client.query(
        `INSERT INTO dwell_stats (yard_id, block, p10_minutes, p50_minutes, p90_minutes, samples) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (yard_id, block) DO UPDATE SET p10_minutes = EXCLUDED.p10_minutes, p50_minutes = EXCLUDED.p50_minutes, p90_minutes = EXCLUDED.p90_minutes, samples = EXCLUDED.samples`,
        [d.yardId, d.block, d.p10, d.p50, d.p90, d.samples],
      )
    }
    const fleet = buildFleet()
    for (const c of fleet) {
      await client.query('INSERT INTO cars (car_id, car_type, owner_mark) VALUES ($1, $2, $3) ON CONFLICT (car_id) DO NOTHING', [c.carId, c.carType, c.ownerMark])
    }
    await client.query('COMMIT')
    console.log(`Seeded ${SHIPPERS.length} shippers, ${USERS.length} users, ${YARDS.length} yards, ${TRAINS.length} trains, ${fleet.length} cars`)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Seed failed:', err)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

await seed()
