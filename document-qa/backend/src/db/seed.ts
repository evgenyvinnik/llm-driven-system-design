/**
 * Seeds orgs, users and groups (idempotent; rerunning restores memberships
 * the demo removed). Documents are not seeded here: `npm run demo:story`
 * uploads the sample corpus through the real API and pipeline.
 *
 * Acme Corp: alice (org admin; Engineering + Finance), carol (member; Engineering only).
 * Globex Inc: bob (org admin; Operations).
 * admin: platform operator (no org, sees pipeline health only).
 * All passwords: password123.
 */
import bcrypt from 'bcryptjs'
import { pool } from '../shared/db.js'

const ORGS = [
  { id: 'org_acme', name: 'Acme Corp' },
  { id: 'org_globex', name: 'Globex Inc' },
]

const USERS = [
  { id: 'usr_alice', username: 'alice', displayName: 'Alice Romero', role: 'org_admin', orgId: 'org_acme' },
  { id: 'usr_carol', username: 'carol', displayName: 'Carol Davis', role: 'member', orgId: 'org_acme' },
  { id: 'usr_bob', username: 'bob', displayName: 'Bob Tanaka', role: 'org_admin', orgId: 'org_globex' },
  { id: 'usr_admin', username: 'admin', displayName: 'Platform Operator', role: 'operator', orgId: null },
]

const GROUPS = [
  { id: 'grp_acme_eng', orgId: 'org_acme', name: 'Engineering', members: ['usr_alice', 'usr_carol'] },
  { id: 'grp_acme_finance', orgId: 'org_acme', name: 'Finance', members: ['usr_alice'] },
  { id: 'grp_globex_ops', orgId: 'org_globex', name: 'Operations', members: ['usr_bob'] },
]

async function seed(): Promise<void> {
  const hash = await bcrypt.hash('password123', 10)
  for (const o of ORGS) await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, [o.id, o.name])
  for (const u of USERS) {
    await pool.query(
      `INSERT INTO users (id, org_id, username, display_name, password_hash, role, active) VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name, role = EXCLUDED.role, active = true`,
      [u.id, u.orgId, u.username, u.displayName, hash, u.role],
    )
  }
  for (const g of GROUPS) {
    await pool.query(`INSERT INTO groups (id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [g.id, g.orgId, g.name])
    for (const m of g.members) await pool.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [g.id, m])
  }
  await pool.query(`UPDATE chaos_switches SET value = 0, updated_at = now()`)
  console.log(`Seeded ${ORGS.length} orgs, ${USERS.length} users, ${GROUPS.length} groups (password: password123)`)
}

try {
  await seed()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
