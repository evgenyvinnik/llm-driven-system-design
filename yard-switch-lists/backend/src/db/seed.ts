/**
 * Seeds users and the yard. Rerunnable: it wipes operational tables first. Stop
 * the services before reseeding.
 *
 * `npm run db:seed` also runs the demo story (db/demo.ts) in-process, through the
 * same services the live system uses, so every screen has real data without a
 * worker or simulator running. `npm run db:seed:plain` stops at a fresh shift with
 * its first solve queued.
 *
 * Users (password123): alice and carol (yardmasters), dave (crew), admin.
 */
import bcrypt from 'bcryptjs'
import { keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { resetYard } from '../plans/yard-load.js'
import { runDemo } from './demo.js'

const USERS = [
  { id: 'u_alice', username: 'alice', name: 'Alice Romero', role: 'yardmaster' },
  { id: 'u_carol', username: 'carol', name: 'Carol Davis', role: 'yardmaster' },
  { id: 'u_dave', username: 'dave', name: 'Dave Okafor', role: 'crew' },
  { id: 'u_admin', username: 'admin', name: 'Admin', role: 'admin' },
] as const

async function clearValkey(): Promise<void> {
  let cursor = '0'
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', keys.pattern, 'COUNT', 500)
    cursor = next
    const keep = found.filter((k) => !k.includes(':session:'))
    if (keep.length) await redis.del(...keep)
  } while (cursor !== '0')
}

async function seed(): Promise<void> {
  const hash = await bcrypt.hash('password123', 10)
  await clearValkey()
  await withTransaction(async (client) => {
    for (const u of USERS) {
      await client.query(
        `INSERT INTO users (id, username, display_name, role, password_hash) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash`,
        [u.id, u.username, u.name, u.role, hash],
      )
    }
    await client.query(`DELETE FROM comparison_runs`)
    await client.query(`DELETE FROM replay_runs`)
    await resetYard(client, { seed: config.simulator.seed, plannerSettings: { iterations: 1500, timeLimitMs: 4000 } })
  })
  console.log(`Seeded users and shift 1 (seed ${config.simulator.seed})`)
  if (process.env.SEED_PLAIN === '1') {
    console.log('Plain seed: first solve queued for the worker. Run `npm run dev` to plan and simulate.')
    return
  }
  await runDemo()
}

try {
  await seed()
  console.log('Seed complete')
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await Promise.allSettled([pool.end(), redis.quit()])
}
