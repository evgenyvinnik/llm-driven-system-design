/** Helpers for integration tests: a clean database and a registered repository. */
import { BASE_TREE, fixtureSpec } from '../githost/fixtures.js'
import * as host from '../githost/store.js'
import type { PullSpec } from '../githost/store.js'
import { resetAll, World } from '../db/materialize.js'
import { pool } from '../shared/db.js'
import type { RepoMode } from '../shared/gate/types.js'
import { DEFAULT_POLICY, loadRepo, type RepoRow } from '../shared/repos.js'
import type { DecisionRow, EscalationRow, IntentRow, RunRow } from '../shared/rows.js'

export const REPO = 'acme/app'
export const OWNER = 'acme'
export const NAME = 'app'
export const REPO_ID = 'repo_test'

export async function freshWorld(mode: RepoMode = 'narrow_auto'): Promise<World> {
  await resetAll()
  await pool.query(`INSERT INTO orgs (id, name) VALUES ('org_acme','Acme'), ('org_globex','Globex')`)
  await pool.query(`INSERT INTO users (id, username, display_name, password_hash, org_id, role) VALUES ('usr_carol','carol','Carol','x','org_acme','repo_admin'), ('usr_alice','alice','Alice','x','org_acme','reviewer'), ('usr_bob','bob','Bob','x','org_globex','repo_admin')`)
  await host.ensureRepo(OWNER, NAME, BASE_TREE)
  const p = DEFAULT_POLICY
  await pool.query(
    `INSERT INTO repositories (id, org_id, full_name, mode, protected_paths, ci_config_paths, policy_paths, max_files, max_changed_lines, auto_approve_scope, required_checks, required_reviewers, bot_logins, link_allowlist, model_version)
     VALUES ($1,'org_acme',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'mock-reviewer-1')`,
    [REPO_ID, REPO, mode, JSON.stringify(p.protectedPaths), JSON.stringify(p.ciConfigPaths), JSON.stringify(p.policyPaths), p.maxFiles, p.maxChangedLines, JSON.stringify(p.autoApproveScope), JSON.stringify(p.requiredChecks), JSON.stringify(p.requiredReviewers), JSON.stringify(p.botLogins), JSON.stringify(p.linkAllowlist)],
  )
  return new World({ ttftMs: 0, tokensPerSecond: 5000 })
}

export async function openFixture(world: World, fixture: string, overrides: Partial<PullSpec> = {}): Promise<{ number: number; headSha: string }> {
  const opened = await host.openPull(OWNER, NAME, { ...fixtureSpec(fixture), ...overrides })
  await world.settle()
  return opened
}

export const repoRow = async (): Promise<RepoRow> => (await loadRepo(pool, REPO_ID)) as RepoRow

export async function activeDecision(number: number): Promise<DecisionRow | undefined> {
  const res = await pool.query<DecisionRow>(`SELECT * FROM decisions WHERE repo_id = $1 AND pr_number = $2 AND state = 'active'`, [REPO_ID, number])
  return res.rows[0]
}

export async function allDecisions(number: number): Promise<DecisionRow[]> {
  return (await pool.query<DecisionRow>(`SELECT * FROM decisions WHERE repo_id = $1 AND pr_number = $2 ORDER BY created_at`, [REPO_ID, number])).rows
}

export async function runsOf(number: number): Promise<RunRow[]> {
  return (await pool.query<RunRow>(`SELECT * FROM review_runs WHERE repo_id = $1 AND pr_number = $2 ORDER BY created_at`, [REPO_ID, number])).rows
}

export async function intentsOf(number: number): Promise<IntentRow[]> {
  return (await pool.query<IntentRow>(`SELECT * FROM post_intents WHERE repo_id = $1 AND pr_number = $2 ORDER BY created_at`, [REPO_ID, number])).rows
}

export async function escalationsOf(number: number): Promise<EscalationRow[]> {
  return (await pool.query<EscalationRow>(`SELECT * FROM escalations WHERE repo_id = $1 AND pr_number = $2 ORDER BY created_at`, [REPO_ID, number])).rows
}

export const liveApprovals = async (number: number) => (await host.listReviews(OWNER, NAME, number)).filter((r) => r.state === 'APPROVED' && !r.dismissed)
