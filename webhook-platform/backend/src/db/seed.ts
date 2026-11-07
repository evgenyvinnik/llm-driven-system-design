/**
 * Seeds two customer orgs (so isolation can be shown), their users, producer
 * API keys and endpoints pointing at the bundled mock receiver, plus an
 * operator account. Re-running wipes all event and delivery history.
 *
 * Local API keys are fixed strings so the README and demo scripts can use
 * them; production keys are random and shown once.
 */
import bcrypt from 'bcryptjs'
import { hashApiKey } from '../shared/auth.js'
import { redis, keys } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { SEED_API_KEYS, SEED_ENDPOINTS } from './seed-data.js'

async function seed(): Promise<void> {
  const hash = await bcrypt.hash('password123', 10)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('TRUNCATE notifications, outbox, attempts, deliveries, ordering_sequences, events, endpoints, api_keys, users, orgs CASCADE')
    await client.query(`INSERT INTO orgs (id, name) VALUES ('org_acme', 'Acme Corp'), ('org_globex', 'Globex Inc')`)
    await client.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, org_id) VALUES
        ('usr_alice', 'alice', 'Alice Romero', $1, 'customer', 'org_acme'),
        ('usr_bob',   'bob',   'Bob Tanaka',   $1, 'customer', 'org_globex'),
        ('usr_admin', 'admin', 'Ops (platform)', $1, 'operator', NULL)`,
      [hash],
    )
    for (const [org, key] of Object.entries(SEED_API_KEYS)) {
      await client.query('INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)', [
        `key_${org}`,
        org,
        'Local producer key',
        key.slice(0, 14),
        hashApiKey(key),
      ])
    }
    for (const e of SEED_ENDPOINTS) {
      await client.query(
        `INSERT INTO endpoints (id, org_id, url, description, event_types, max_concurrency, secret_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [e.id, e.org, `${config.receiverUrl}/hooks/${e.path}`, e.description, [...e.types], e.concurrency, e.secret],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  // Stale semaphore leases from a previous run would otherwise linger until they expire.
  const slotKeys = await redis.keys(keys.slotsPattern)
  if (slotKeys.length > 0) await redis.del(...slotKeys)

  console.log('Seeded orgs acme (alice) and globex (bob), operator admin; password password123')
  console.log(`Endpoints point at ${config.receiverUrl}/hooks/*`)
  console.log(`Producer API keys: acme ${SEED_API_KEYS.org_acme}  globex ${SEED_API_KEYS.org_globex}`)
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
