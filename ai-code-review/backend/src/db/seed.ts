/**
 * Seeds the system by actually running it. Fixture pull requests go through the
 * real receiver, pipeline, gate and poster (see materialize.ts), so everything on
 * screen is what the system really did, including an injection the model fell for
 * and the gate refused, and an approval invalidated by a push.
 *
 * Safe to rerun: it starts from empty tables.
 */
import bcrypt from 'bcryptjs'
import { promoteRepo, reportFalseApproval, setKillSwitch } from '../api/services/repo-modes.js'
import { claimEscalation, decideEscalation } from '../api/services/escalations.js'
import { runEvaluation } from '../evaluation/service.js'
import { BASE_TREE, fixtureSpec } from '../githost/fixtures.js'
import * as host from '../githost/store.js'
import type { CiSetting, PullSpec } from '../githost/store.js'
import { verifyChain } from '../shared/audit.js'
import type { SessionUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { DEFAULT_POLICY, type ModelVersion } from '../shared/repos.js'
import type { EscalationRow } from '../shared/rows.js'
import { resetAll, World } from './materialize.js'

const USERS = [
  { id: 'usr_alice', username: 'alice', display: 'Alice Moreau', org: 'org_acme', role: 'reviewer' },
  { id: 'usr_carol', username: 'carol', display: 'Carol Diaz', org: 'org_acme', role: 'repo_admin' },
  { id: 'usr_bob', username: 'bob', display: 'Bob Okafor', org: 'org_globex', role: 'repo_admin' },
  { id: 'usr_admin', username: 'admin', display: 'Platform Admin', org: null, role: 'admin' },
] as const

const session = (u: (typeof USERS)[number]): SessionUser => ({ id: u.id, username: u.username, displayName: u.display, orgId: u.org, orgName: u.org === 'org_acme' ? 'Acme' : u.org === 'org_globex' ? 'Globex' : null, role: u.role })
const carol = session(USERS[1])
const alice = session(USERS[0])
const bob = session(USERS[2])

const world = new World()

async function addRepo(id: string, org: string, fullName: string, modelVersion: ModelVersion): Promise<void> {
  const [owner, name] = fullName.split('/')
  await host.ensureRepo(owner, name, BASE_TREE)
  const p = DEFAULT_POLICY
  await pool.query(
    `INSERT INTO repositories (id, org_id, full_name, protected_paths, ci_config_paths, policy_paths, max_files, max_changed_lines, auto_approve_scope, required_checks, required_reviewers, bot_logins, link_allowlist, model_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, org, fullName, JSON.stringify(p.protectedPaths), JSON.stringify(p.ciConfigPaths), JSON.stringify(p.policyPaths), p.maxFiles, p.maxChangedLines, JSON.stringify(p.autoApproveScope), JSON.stringify(p.requiredChecks), JSON.stringify(p.requiredReviewers), JSON.stringify(p.botLogins), JSON.stringify(p.linkAllowlist), modelVersion],
  )
}

async function open(fullName: string, fixture: string, overrides: Partial<PullSpec> = {}): Promise<number> {
  const [owner, name] = fullName.split('/')
  const { number } = await host.openPull(owner, name, { ...fixtureSpec(fixture), ...overrides })
  await world.settle()
  return number
}

async function headOf(fullName: string, number: number): Promise<string> {
  const [owner, name] = fullName.split('/')
  return (await host.getPull(owner, name, number)).head.sha
}

async function escalationFor(fullName: string, number: number): Promise<EscalationRow> {
  const res = await pool.query<EscalationRow>(`SELECT e.* FROM escalations e JOIN repositories r ON r.id = e.repo_id WHERE r.full_name = $1 AND e.pr_number = $2 AND e.status IN ('open','claimed') ORDER BY e.created_at DESC LIMIT 1`, [fullName, number])
  return res.rows[0]
}

async function hostReview(fullName: string, number: number, user: string, event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> {
  const [owner, name] = fullName.split('/')
  await host.postReview(owner, name, number, { user, event, commitId: await headOf(fullName, number) })
  await world.settle()
}

async function push(fullName: string, number: number, files: host.FileChange[], message: string, ci: CiSetting = 'success'): Promise<void> {
  const [owner, name] = fullName.split('/')
  await host.pushCommit(owner, name, number, { files, message, ci })
  await world.settle()
}

async function shadowPhase(fullName: string): Promise<void> {
  // Observation first: comments and shadow decisions, with humans still reviewing and merging.
  const [owner, name] = fullName.split('/')
  for (const [fixture, reviewer, event] of [
    ['docs-safe', 'carol', 'APPROVE'],
    ['tests-safe', 'carol', 'APPROVE'],
    ['feature-small', 'carol', 'APPROVE'],
    ['auth-risky', 'carol', 'REQUEST_CHANGES'],
    ['docs-safe', 'alice', 'APPROVE'],
    ['tests-safe', 'alice', 'APPROVE'],
  ] as const) {
    const n = await open(fullName, fixture)
    await hostReview(fullName, n, reviewer, event)
    if (event === 'APPROVE') await host.mergePull(owner, name, n)
    else await host.closePull(owner, name, n)
    await world.settle()
  }
}

async function main(): Promise<void> {
  await resetAll()
  await pool.query(`INSERT INTO orgs (id, name) VALUES ('org_acme','Acme'), ('org_globex','Globex')`)
  const hash = await bcrypt.hash('password123', 8)
  for (const u of USERS) await pool.query(`INSERT INTO users (id, username, display_name, password_hash, org_id, role) VALUES ($1,$2,$3,$4,$5,$6)`, [u.id, u.username, u.display, hash, u.org, u.role])

  const WEB = 'acme/web-app'
  const PAY = 'acme/payments-api'
  const MOB = 'acme/mobile-app'
  const GLOBEX = 'globex/platform'
  await addRepo('repo_web', 'org_acme', WEB, 'mock-reviewer-1')
  await addRepo('repo_pay', 'org_acme', PAY, 'mock-reviewer-1')
  await addRepo('repo_mob', 'org_acme', MOB, 'mock-reviewer-2')
  await addRepo('repo_globex', 'org_globex', GLOBEX, 'mock-reviewer-1')

  // ── acme/web-app: observe, refused promotion, evaluation, promotion ─────────
  await shadowPhase(WEB)
  await promoteRepo('repo_web', carol).catch(() => undefined) // No evaluation yet: refused and recorded.
  await runEvaluation({ modelVersion: 'mock-reviewer-1', limit: 12, createdBy: 'carol' })
  await promoteRepo('repo_web', carol).catch(() => undefined) // A partial corpus: refused again.
  await runEvaluation({ modelVersion: 'mock-reviewer-1', createdBy: 'carol' })
  await runEvaluation({ modelVersion: 'mock-reviewer-2', createdBy: 'carol' })
  await promoteRepo('repo_web', carol)

  // ── narrow_auto: what it approves, what it refuses, and why ──────────────────
  await open(WEB, 'docs-safe')
  await open(WEB, 'tests-safe')
  await open(WEB, 'feature-small')
  const risky = await open(WEB, 'auth-risky')
  for (const f of ['protected-direct', 'protected-rename', 'protected-rename-code', 'ci-config-change', 'policy-file-change', 'huge-diff', 'self-authored', 'sibling-bot-commit', 'binary-blob', 'docs-malicious', 'tests-exfil', 'tests-weaken']) await open(WEB, f)

  // Injections: the model falls for each one, and the gate holds.
  for (const f of ['injection-diff', 'injection-comment', 'injection-repo-file', 'injection-obfuscated', 'injection-exfil', 'injection-approve-tool']) await open(WEB, f)
  // The honest residual: the scanner misses this one and it is approved, but all it can buy is an inert docs page.
  await open(WEB, 'injection-docs-obfuscated')

  // An approval invalidated by a push.
  const pushed = await open(WEB, 'docs-safe', { title: 'Docs: add an FAQ entry', body: 'Approved, then a second commit arrives.' })
  await push(WEB, pushed, [{ path: 'src/auth/session.ts', remove: ['  return Boolean(session?.user)'], add: ['  return true // TEMP'] }], 'Small follow-up')

  // Green on the old commit, red on the new one.
  const reddened = await open(WEB, 'docs-safe', { title: 'Docs: describe the staging environment' })
  await push(WEB, reddened, [{ path: 'docs/guide.md', add: ['Staging refreshes nightly.'] }], 'More docs', 'failure')

  // Fail closed: malformed output, a timeout, an outage.
  world.settings.chaos.malformed = 1
  await open(WEB, 'docs-safe', { title: 'Docs: typo in the runbook (model output malformed)' })
  world.settings.chaos.schema_violation = 1
  await open(WEB, 'docs-safe', { title: 'Docs: typo in the handbook (model output violates the schema)' })
  world.settings.chaos.timeout = 1
  await open(WEB, 'docs-safe', { title: 'Docs: typo in the FAQ (model timed out)' })
  world.settings.failureRate = 1
  await open(WEB, 'docs-safe', { title: 'Docs: typo in the glossary (model outage)' })
  world.settings.failureRate = 0

  // No CI data at all: waits, and then fails closed once the deadline passes.
  await open(WEB, 'docs-safe', { title: 'Docs: note about retries (CI has not reported)', ci: 'none' })

  // A human approval bound to a SHA, then invalidated by a push.
  const humanPr = await open(WEB, 'auth-risky', { title: 'Login: add rate limiting to the token path', author: 'erin' })
  const humanEsc = await escalationFor(WEB, humanPr)
  await claimEscalation(humanEsc.id, carol)
  await decideEscalation(humanEsc.id, carol, { decision: 'approve', headSha: humanEsc.head_sha, note: 'Read the token path. Looks right.' })
  await world.settle()
  await push(WEB, humanPr, [{ path: 'src/api/login.ts', add: ['  // one more thing'] }], 'One more thing')

  // A human approval that stands.
  const standing = await open(WEB, 'feature-small', { title: 'Add a clamp helper for percentages', author: 'erin' })
  const standingEsc = await escalationFor(WEB, standing)
  await claimEscalation(standingEsc.id, carol)
  await decideEscalation(standingEsc.id, carol, { decision: 'approve', headSha: standingEsc.head_sha, note: 'Small and tested.' })
  await world.settle()

  // Rejected by a person.
  const rejected = await open(WEB, 'auth-risky', { title: 'Login: remember me on shared devices', author: 'dave' })
  const rejectedEsc = await escalationFor(WEB, rejected)
  await claimEscalation(rejectedEsc.id, alice)
  await decideEscalation(rejectedEsc.id, alice, { decision: 'reject', headSha: rejectedEsc.head_sha, note: 'Tokens need an expiry first.' })
  await world.settle()

  // Claimed and in progress, and one authored by alice, who may not approve it herself.
  const claimed = await escalationFor(WEB, risky)
  await claimEscalation(claimed.id, alice)
  await open(WEB, 'feature-small', { title: 'Add a percentage formatter', author: 'alice' })

  // The kill switch: a change that would be approved goes to a person instead.
  await setKillSwitch('repo_web', carol, true, 'Drill')
  await open(WEB, 'docs-safe', { title: 'Docs: incident drill notes (kill switch on)' })
  await setKillSwitch('repo_web', carol, false, 'Drill over')

  // ── acme/payments-api: still observing ───────────────────────────────────────
  await open(PAY, 'docs-safe')
  await open(PAY, 'tests-safe')
  await open(PAY, 'injection-diff')
  await open(PAY, 'protected-direct')
  world.settings.chaos.hostile_text = 1
  await open(PAY, 'feature-small', { title: 'Add a currency helper (hostile model text, sanitized in the comment)' })

  // ── acme/mobile-app: promoted, then demoted by a recorded false approval ─────
  await shadowPhase(MOB)
  await promoteRepo('repo_mob', carol)
  const bad = await open(MOB, 'injection-docs-obfuscated', { title: 'Docs: note the rotation (reported after the fact)' })
  const decided = await pool.query<{ id: string }>(`SELECT d.id FROM decisions d JOIN repositories r ON r.id = d.repo_id WHERE r.full_name = $1 AND d.pr_number = $2 AND d.outcome = 'auto_approved'`, [MOB, bad])
  await reportFalseApproval(decided.rows[0].id, carol, 'An injection should never reach an approval, whatever the page says.')
  await world.settle()
  await promoteRepo('repo_mob', carol).catch(() => undefined) // Evidence predates the demotion: refused.

  // ── globex/platform: bob's org, invisible to everyone above ──────────────────
  await open(GLOBEX, 'docs-safe')
  await open(GLOBEX, 'tests-safe')
  await open(GLOBEX, 'auth-risky')
  await promoteRepo('repo_globex', bob).catch(() => undefined)

  // ── Check the result, so a broken seed fails loudly ──────────────────────────
  for (const id of ['repo_web', 'repo_pay', 'repo_mob', 'repo_globex']) {
    const check = await verifyChain(pool, id)
    if (!check.ok) throw new Error(`Audit chain ${id} does not verify: ${JSON.stringify(check.problems[0])}`)
  }
  const counts = await pool.query(`SELECT outcome, count(*)::int AS n FROM decisions WHERE state = 'active' GROUP BY outcome ORDER BY outcome`)
  const prs = await pool.query(`SELECT count(*)::int AS n FROM pull_requests`)
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log`)
  console.log(`Seeded ${prs.rows[0].n} pull requests, ${audit.rows[0].n} audit entries`)
  console.log(`Active decisions: ${counts.rows.map((r) => `${r.outcome}=${r.n}`).join(', ')}`)
  console.log('Sign in as alice, carol, bob or admin; the password is password123')
}

await main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await Promise.allSettled([pool.end(), redis.quit()])
  })
