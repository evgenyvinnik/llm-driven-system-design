/**
 * Repository policy. It lives in this service's database and is changed only by
 * repo admins through the audited API. It is never read from the repository,
 * and especially not from a pull request's head branch: a change must not be
 * able to set the terms of its own review.
 * @module shared/repos
 */
import type { Queryable } from './db.js'
import { config } from './config.js'
import type { GatePolicy, RepoMode, ScopeCategory } from './gate/types.js'

export const MODEL_VERSIONS = ['mock-reviewer-1', 'mock-reviewer-2'] as const
export type ModelVersion = (typeof MODEL_VERSIONS)[number]

export const DEFAULT_POLICY: GatePolicy = {
  protectedPaths: ['src/auth/**', 'src/payments/**', 'migrations/**', 'infra/**', 'secrets/**', '**/*.pem'],
  ciConfigPaths: ['dockerfile', 'makefile', 'package.json', 'package-lock.json', '**/vitest.config.*', '**/jest.config.*'],
  policyPaths: ['.review-bot/**'],
  maxFiles: 20,
  maxChangedLines: 400,
  autoApproveScope: ['docs', 'tests'],
  requiredChecks: ['ci/build', 'ci/test'],
  requiredReviewers: [],
  botLogins: [config.botLogin, 'code-assistant-bot'],
  linkAllowlist: ['github.com', 'example.com', 'acme.dev', 'localhost'],
}

export interface RepoRow {
  id: string
  org_id: string
  full_name: string
  mode: RepoMode
  kill_switch: boolean
  protected_paths: string[]
  ci_config_paths: string[]
  policy_paths: string[]
  max_files: number
  max_changed_lines: number
  auto_approve_scope: ScopeCategory[]
  required_checks: string[]
  required_reviewers: string[]
  bot_logins: string[]
  link_allowlist: string[]
  model_version: string
  settings_version: number
  demoted_at: Date | null
  demoted_reason: string | null
  mode_changed_at: Date
  created_at: Date
  updated_at: Date
}

export function policyOf(r: RepoRow): GatePolicy {
  return {
    protectedPaths: r.protected_paths,
    ciConfigPaths: r.ci_config_paths,
    policyPaths: r.policy_paths,
    maxFiles: r.max_files,
    maxChangedLines: r.max_changed_lines,
    autoApproveScope: r.auto_approve_scope,
    requiredChecks: r.required_checks,
    requiredReviewers: r.required_reviewers,
    botLogins: r.bot_logins,
    linkAllowlist: r.link_allowlist,
  }
}

export async function loadRepo(db: Queryable, id: string): Promise<RepoRow | null> {
  const res = await db.query<RepoRow>(`SELECT * FROM repositories WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function loadRepoByName(db: Queryable, fullName: string): Promise<RepoRow | null> {
  const res = await db.query<RepoRow>(`SELECT * FROM repositories WHERE full_name = $1`, [fullName])
  return res.rows[0] ?? null
}

export function repoDto(r: RepoRow) {
  return {
    id: r.id,
    orgId: r.org_id,
    fullName: r.full_name,
    mode: r.mode,
    killSwitch: r.kill_switch,
    protectedPaths: r.protected_paths,
    ciConfigPaths: r.ci_config_paths,
    policyPaths: r.policy_paths,
    maxFiles: r.max_files,
    maxChangedLines: r.max_changed_lines,
    autoApproveScope: r.auto_approve_scope,
    requiredChecks: r.required_checks,
    requiredReviewers: r.required_reviewers,
    botLogins: r.bot_logins,
    linkAllowlist: r.link_allowlist,
    modelVersion: r.model_version,
    settingsVersion: r.settings_version,
    demotedAt: r.demoted_at?.toISOString() ?? null,
    demotedReason: r.demoted_reason,
    modeChangedAt: r.mode_changed_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}
