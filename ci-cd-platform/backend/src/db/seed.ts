/**
 * Resets the database to a known state: organizations, users, repositories, environments,
 * secrets, and a history of runs materialized through the real engine. Idempotent: it
 * truncates first. Real runners are kept away from the repositories while it works.
 * @module db/seed
 */
import bcrypt from 'bcryptjs'
import { encrypt } from '../shared/crypto.js'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { putSecret } from '../secrets/store.js'
import { webhookAad } from '../api/routes/webhooks.js'
import { ENVIRONMENTS, MEMBERS, ORGS, REPOS, SECRETS, USERS } from './seed-data.js'
import { materializeStories, RUNNER_ONE, RUNNER_TWO } from './seed-stories.js'

const PASSWORD = 'password123'

async function seed(): Promise<void> {
  await pool.query(`TRUNCATE orgs, runners, workflow_files, secret_releases, job_transitions RESTART IDENTITY CASCADE`)
  for (const o of ORGS) await pool.query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [o.id, o.name])
  const hash = await bcrypt.hash(PASSWORD, 8)
  for (const u of USERS) await pool.query('INSERT INTO users (id, org_id, username, display_name, password_hash, is_admin) VALUES ($1, $2, $3, $4, $5, $6)', [u.id, u.org, u.username, u.displayName, hash, u.isAdmin])
  for (const r of REPOS) {
    await pool.query('INSERT INTO repositories (id, org_id, full_name, webhook_secret_enc, max_concurrent_jobs, claims_paused) VALUES ($1, $2, $3, $4, $5, true)', [r.id, r.org, r.fullName, encrypt(r.webhookSecret, webhookAad(r.id)), r.limit])
  }
  for (const m of MEMBERS) await pool.query('INSERT INTO repo_members (repo_id, user_id, role) VALUES ($1, $2, $3)', [m.repo, m.user, m.role])
  for (const e of ENVIRONMENTS) await pool.query('INSERT INTO environments (id, repo_id, name, required_approval, allowed_branches) VALUES ($1, $2, $3, $4, $5)', [e.id, e.repo, e.name, e.requiredApproval, e.allowedBranches])
  for (const s of SECRETS) await putSecret(pool, s.repo, s.name, s.value, s.environment, s.by)
  for (const runner of [RUNNER_ONE, RUNNER_TWO]) {
    await pool.query(`INSERT INTO runners (id, name, labels, slots, token_hash, last_seen_at) VALUES ($1, $2, $3, 2, $4, now() - interval '1 hour')`, [runner.id, runner.name, runner.labels, `seeded-${runner.id}`])
  }

  await materializeStories()
  await pool.query('UPDATE repositories SET claims_paused = false')
  const counts = await pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM workflow_runs GROUP BY status ORDER BY status')
  console.log(`Seeded ${USERS.length} users, ${REPOS.length} repositories and runs: ${counts.rows.map((c) => `${c.n} ${c.status}`).join(', ')}`)
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
