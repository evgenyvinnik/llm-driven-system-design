/**
 * Seeds a fictional enterprise, Northwind Holdings:
 * - users: alice (security engineer), bob (payments owner), carol (approver),
 *   dave (data-platform owner); every password is password123
 * - the simulated fleet (FLEET_SEED, default 1,500 accounts in 50 subscriptions),
 *   written to the simulator's state file
 * - a first full scan and usage-evidence pass, run in-process against the same
 *   fleet, so the dashboard has data before any service starts
 * - exceptions in every state, including one that expires a few minutes after
 *   seeding (to watch the finding reopen on its own)
 * - 30 days of posture history BEFORE the first scan, marked source='seed'
 *
 * Rerunnable: it truncates every table and clears the Valkey stream keys.
 */
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { InProcessControlPlane } from '../arm/in-process.js'
import { Fleet } from '../cloud-sim/fleet.js'
import { generateFleet } from '../cloud-sim/generate.js'
import { CONTROLS } from '../domain/controls.js'
import { fullScan } from '../scanner/full-scan.js'
import { refreshEvidence } from '../scanner/evidence.js'
import { saveCursor } from '../scanner/changes.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { newId } from '../shared/ids.js'
import { snapshotPosture } from '../store/posture.js'

const USERS = [
  { id: 'u_alice', username: 'alice', name: 'Alice Chen', role: 'security', team: null },
  { id: 'u_bob', username: 'bob', name: 'Bob Ortiz', role: 'owner', team: 'payments' },
  { id: 'u_carol', username: 'carol', name: 'Carol Davis', role: 'approver', team: null },
  { id: 'u_dave', username: 'dave', name: 'Dave Kim', role: 'owner', team: 'data-platform' },
] as const

const quietLog = { info: () => undefined, warn: (o: object, m?: string) => console.warn(m, o) }

async function clearValkey(): Promise<void> {
  const { Redis } = await import('ioredis')
  const client = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 })
  client.on('error', () => undefined)
  try {
    await client.connect()
    const keys = [config.stream.tasks, ...(await client.keys('campaign:*:events')), ...(await client.keys('bucket:*'))]
    if (keys.length) await client.del(...keys)
    console.log(`Cleared ${keys.length} Valkey keys`)
  } catch {
    console.warn('Valkey not reachable; skipped clearing stream keys')
  } finally {
    client.disconnect()
  }
}

async function seedExceptions(): Promise<number> {
  const pick = async (team: string, control: string, evidence?: string) => {
    const { rows } = await pool.query<{ account_id: string; name: string }>(
      `SELECT f.account_id, a.name FROM findings f JOIN storage_accounts a ON a.id = f.account_id
        WHERE a.owner = $1 AND f.control_id = $2 AND f.status = 'open' AND ($3::text IS NULL OR f.evidence_class = $3)
          AND NOT EXISTS (SELECT 1 FROM exceptions e WHERE e.account_id = f.account_id AND e.control_id = f.control_id)
        ORDER BY a.name LIMIT 1`,
      [team, control, evidence ?? null],
    )
    return rows[0]
  }
  const specs = [
    { team: 'payments', control: 'SA-02', evidence: 'needs_owner_migration', status: 'approved', days: 90, ageDays: 70, justification: 'Partner SFTP gateway authenticates with the account key. Migration to a managed identity is scheduled with the vendor for next quarter.' },
    { team: 'payments', control: 'SA-03', status: 'approved', days: 30, ageDays: 30, expiresInMinutes: 4, justification: 'Legacy POS reconciliation client only speaks TLS 1.0; replacement terminals are being rolled out store by store.' },
    { team: 'payments', control: 'SA-01', status: 'pending', days: 60, ageDays: 1, justification: 'Static receipt images are served anonymously to customer emails. Moving them behind the CDN with a private origin.' },
    { team: 'data-platform', control: 'SA-05', status: 'pending', days: 45, ageDays: 2, justification: 'Databricks workspace reaches this account over the public endpoint until the private endpoint migration finishes.' },
    { team: 'data-platform', control: 'SA-02', status: 'rejected', days: 180, ageDays: 20, justification: 'Nightly export job uses the account key and we do not have time to change it this half.' },
    { team: 'payments', control: 'SA-06', status: 'expired', days: 14, ageDays: 40, justification: 'Soft delete doubled storage cost during the migration window; re-enabling after cutover.' },
  ]
  let n = 0
  for (const s of specs) {
    const target = await pick(s.team, s.control, s.evidence)
    if (!target) continue
    const requester = s.team === 'payments' ? 'u_bob' : 'u_dave'
    const created = new Date(Date.now() - s.ageDays * 86_400_000)
    const decided = s.status === 'pending' ? null : new Date(created.getTime() + 86_400_000)
    const expires =
      s.status === 'approved' ? new Date(s.expiresInMinutes ? Date.now() + s.expiresInMinutes * 60_000 : decided!.getTime() + s.days * 86_400_000) : s.status === 'expired' ? new Date(decided!.getTime() + s.days * 86_400_000) : null
    const id = newId('exc')
    await pool.query(
      `INSERT INTO exceptions (id, account_id, control_id, status, justification, requested_by, requested_days, decided_by, decided_at, decision_note, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, target.account_id, s.control, s.status, s.justification, requester, s.days, decided ? 'u_carol' : null, decided, s.status === 'rejected' ? 'Use a user delegation SAS; this is a two-day change.' : null, expires, created],
    )
    await pool.query(`INSERT INTO audit_log (at, actor, action, account_id, control_id, details) VALUES ($1, $2, 'exception.requested', $3, $4, $5)`, [created, `user:${requester === 'u_bob' ? 'bob' : 'dave'}`, target.account_id, s.control, JSON.stringify({ exceptionId: id, days: s.days })])
    if (decided) {
      await pool.query(`INSERT INTO audit_log (at, actor, action, account_id, control_id, details) VALUES ($1, 'user:carol', $2, $3, $4, $5)`, [decided, s.status === 'rejected' ? 'exception.rejected' : 'exception.approved', target.account_id, s.control, JSON.stringify({ exceptionId: id })])
    }
    if (s.status === 'approved') await pool.query(`UPDATE findings SET status = 'exempt' WHERE account_id = $1 AND control_id = $2`, [target.account_id, s.control])
    n++
  }
  return n
}

/** Daily points for the 30 days before the first scan, trending toward today's numbers. Marked source='seed'. */
async function seedHistory(): Promise<void> {
  const current = await snapshotPosture(pool, new Date(), 'scan')
  const improvement: Record<string, number> = { 'SA-01': 0.12, 'SA-02': 0.03, 'SA-03': 0.07, 'SA-04': 0.02, 'SA-05': 0.05, 'SA-06': 0.16, 'SA-07': 0.22 }
  for (let d = 30; d >= 1; d--) {
    const at = new Date(Date.now() - d * 86_400_000)
    at.setUTCHours(6, 0, 0, 0)
    for (const p of current) {
      const wobble = Math.sin(d * 1.7 + p.controlId.charCodeAt(4)) * 0.004
      const backlog = Math.round(p.total * Math.max(0, improvement[p.controlId] * (d / 30) + wobble))
      const compliant = Math.max(0, p.compliant - backlog)
      await pool.query(
        `INSERT INTO posture_snapshots (taken_at, control_id, total, compliant, open, exempt, source) VALUES ($1, $2, $3, $4, $5, $6, 'seed') ON CONFLICT DO NOTHING`,
        [at, p.controlId, p.total, compliant, Math.max(0, p.total - compliant - p.exempt), p.exempt],
      )
    }
  }
}

async function seed(): Promise<void> {
  const started = Date.now()
  await pool.query(`TRUNCATE campaign_targets, campaign_waves, campaigns, findings, usage_evidence, exceptions, notifications, posture_snapshots,
                    scan_runs, scanner_cursors, audit_log, storage_accounts, subscriptions, controls, users RESTART IDENTITY CASCADE`)
  await clearValkey()

  const hash = await bcrypt.hash('password123', 10)
  for (const u of USERS) {
    await pool.query('INSERT INTO users (id, username, display_name, password_hash, role, team) VALUES ($1, $2, $3, $4, $5, $6)', [u.id, u.username, u.name, hash, u.role, u.team])
  }
  for (const c of CONTROLS) {
    await pool.query('INSERT INTO controls (id, version, key, title, kind, severity, breaking, policy_effect) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      c.id,
      c.version,
      c.key,
      c.title,
      c.kind,
      c.severity,
      c.breaking,
      c.policy.effects.includes('audit') ? 'audit' : 'auditIfNotExists',
    ])
  }

  const state = generateFleet(config.sim.fleetSeed, config.sim.subscriptions, config.sim.accounts)
  const stateFile = resolve(config.sim.stateFile)
  new Fleet(structuredClone(state)).save(stateFile)
  console.log(`Generated ${state.accounts.length} storage accounts in ${state.subscriptions.length} subscriptions → ${stateFile}`)

  // Scan the same fleet in-process, with platform limits relaxed so seeding is quick.
  const scanFleet = new Fleet(structuredClone(state))
  scanFleet.setFaults({ readCapacity: 100_000, readRefillPerSec: 100_000, graphCapacity: 1000, graphRefillPerSec: 1000 })
  const deps = {
    db: pool,
    arm: new InProcessControlPlane(scanFleet, 'seed'),
    shard: { index: 0, count: 1 },
    lookbackDays: config.scanner.lookbackDays,
    minEvidenceDays: config.scanner.minEvidenceDays,
    readConcurrency: 16,
    childRefreshMs: config.scanner.childRefreshMs,
    evidenceTtlMs: config.scanner.evidenceTtlMs,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log: quietLog,
  }
  const scan = await fullScan(deps)
  console.log(`First full scan: ${scan.accountsSeen} accounts, ${scan.childrenRead} child resources, ${scan.open} open findings`)
  const evidence = await refreshEvidence(deps, { limit: 100_000, force: true })
  console.log(`Usage evidence computed for ${evidence} accounts`)
  await saveCursor(deps, state.nextSeq - 1, null)

  console.log(`Seeded ${await seedExceptions()} exceptions`)
  await seedHistory()
  const { rows } = await pool.query<{ evidence_class: string; n: number }>(`SELECT evidence_class, count(*)::int AS n FROM findings WHERE status = 'open' GROUP BY 1 ORDER BY 1`)
  console.log('Open findings by evidence class:', Object.fromEntries(rows.map((r) => [r.evidence_class, r.n])))

  // If the simulator is already running, have it pick up the new fleet.
  await fetch(`${config.simUrl}/admin/reload`, { method: 'POST', signal: AbortSignal.timeout(1500) })
    .then(() => console.log('Running cloud simulator reloaded the fleet'))
    .catch(() => undefined)
  console.log(`Seed completed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

try {
  await seed()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
