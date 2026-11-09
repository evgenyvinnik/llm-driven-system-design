/**
 * The deterministic policy gate. Each rule is a pure function of facts fetched
 * from the host and policy held outside the repository. No rule reads model
 * output: a model cannot talk this module into anything, because nothing it
 * says reaches it.
 *
 * Bump POLICY_VERSION with any behaviour change. It is recorded on every
 * decision, and promotion needs an evaluation of exactly this version.
 * @module shared/gate/rules
 */
import { classifyChange } from './category.js'
import { matchesAny, normalizePath, touchedPaths } from './paths.js'
import type { GateFacts, GatePolicy, GateResult, RuleId, RuleResult, RuleStatus } from './types.js'

export const POLICY_VERSION = '2026.11.1'

/** Floors a repo admin cannot remove: these files define the controls themselves. */
export const CI_CONFIG_FLOOR = [
  '.github/workflows/**',
  '.github/actions/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  '.buildkite/**',
  'jenkinsfile',
  'azure-pipelines.yml',
]
export const POLICY_FLOOR = [
  '.autoreview.yml',
  '.review-policy.yml',
  '.ai-review/**',
  'codeowners',
  '.github/codeowners',
  'docs/codeowners',
  // Instruction files for coding agents: they look like docs and steer whichever agent reads them.
  '**/claude.md',
  '**/agents.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
]

function rule(id: RuleId, status: RuleStatus, reason: string, evidence?: unknown): RuleResult {
  return evidence === undefined ? { id, status, reason } : { id, status, reason, evidence }
}

export function boundToCurrentHead(f: GateFacts): RuleResult {
  const id = 'bound_to_current_head'
  if (f.pr.state !== 'open') return rule(id, 'fail', `The pull request is ${f.pr.state}`)
  if (f.pr.headSha !== f.boundSha) {
    return rule(id, 'fail', `This decision is for ${f.boundSha.slice(0, 7)}, but the head is now ${f.pr.headSha.slice(0, 7)}`, { boundSha: f.boundSha, headSha: f.pr.headSha })
  }
  if (f.pr.baseRef !== f.boundBaseRef) {
    return rule(id, 'fail', `This decision targets ${f.boundBaseRef}, but the pull request now targets ${f.pr.baseRef}`)
  }
  return rule(id, 'pass', `Head is ${f.boundSha.slice(0, 7)}, base is ${f.boundBaseRef}`)
}

export function ciGreenAtHead(f: GateFacts, p: GatePolicy): RuleResult {
  const id = 'ci_green_at_head'
  if (f.checks === null) return rule(id, 'unknown', 'Check results could not be read')
  // Green on another commit says nothing about this one.
  const atHead = f.checks.filter((c) => c.headSha === f.boundSha)
  const required = p.requiredChecks
  if (required.length === 0 && atHead.length === 0) return rule(id, 'unknown', 'No checks reported at this SHA, and none are configured')
  const names = required.length > 0 ? required : atHead.map((c) => c.name)
  const failed: string[] = []
  const pending: string[] = []
  for (const name of names) {
    const check = atHead.find((c) => c.name === name)
    if (!check || check.status !== 'completed') pending.push(name)
    else if (check.conclusion !== 'success') failed.push(`${name}: ${check.conclusion}`)
  }
  if (failed.length > 0) return rule(id, 'fail', `Failed at this SHA: ${failed.join(', ')}`, { failed })
  if (pending.length > 0) return rule(id, 'unknown', `Not finished at this SHA: ${pending.join(', ')}`, { pending })
  return rule(id, 'pass', `${names.length} required check(s) passed at ${f.boundSha.slice(0, 7)}`)
}

export function requiredReviewersApproved(f: GateFacts, p: GatePolicy): RuleResult {
  const id = 'required_reviewers_approved'
  if (f.reviews === null) return rule(id, 'unknown', 'Reviews could not be read')
  const live = f.reviews.filter((r) => !r.dismissed && !p.botLogins.includes(r.user))
  // Each person's latest word counts, across commits: a change request stands until they lift it.
  const latest = new Map<string, (typeof live)[number]>()
  for (const r of [...live].filter((r) => r.state !== 'COMMENTED').sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) latest.set(r.user, r)
  const blocking = [...latest.values()].filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.user)
  if (blocking.length > 0) return rule(id, 'fail', `Changes requested by ${blocking.join(', ')}`, { blocking })
  const missing = p.requiredReviewers.filter((u) => {
    const r = latest.get(u)
    return !r || r.state !== 'APPROVED' || r.commitId !== f.boundSha
  })
  if (missing.length > 0) return rule(id, 'fail', `No approval at this SHA from ${missing.join(', ')}`, { missing })
  return rule(id, 'pass', p.requiredReviewers.length > 0 ? `${p.requiredReviewers.length} required reviewer(s) approved at this SHA` : 'No required reviewers configured, no outstanding change requests')
}

export function noProtectedPaths(f: GateFacts, p: GatePolicy): RuleResult {
  const id = 'no_protected_paths'
  const hits: { path: string; pattern: string }[] = []
  for (const t of touchedPaths(f.files)) {
    if (t.escapesRoot || t.absolute) {
      hits.push({ path: t.path, pattern: '(escapes repository root)' })
      continue
    }
    const pattern = matchesAny(t.path, p.protectedPaths)
    if (pattern) hits.push({ path: t.path, pattern })
  }
  if (hits.length > 0) return rule(id, 'fail', `Touches ${hits.map((h) => h.path).join(', ')} (protected by ${hits[0].pattern})`, { hits })
  return rule(id, 'pass', `No path, including rename sources, matches ${p.protectedPaths.length} protected pattern(s)`)
}

export function withinSizeLimits(f: GateFacts, p: GatePolicy): RuleResult {
  const id = 'within_size_limits'
  if (f.pr.changedFiles > p.maxFiles) return rule(id, 'fail', `${f.pr.changedFiles} files exceeds the limit of ${p.maxFiles}`, { files: f.pr.changedFiles })
  // A truncated or short list is not a small change, it is an unread one.
  if (f.pr.filesTruncated || f.pr.changedFiles !== f.files.length) {
    return rule(id, 'unknown', `The host reports ${f.pr.changedFiles} changed file(s), but the list has ${f.files.length}`, { changedFiles: f.pr.changedFiles, listed: f.files.length })
  }
  const lines = f.files.reduce((sum, x) => sum + x.additions + x.deletions, 0)
  if (lines > p.maxChangedLines) return rule(id, 'fail', `${lines} changed lines exceeds the limit of ${p.maxChangedLines}`, { files: f.files.length, lines })
  return rule(id, 'pass', `${f.files.length} file(s), ${lines} changed line(s)`)
}

/** Identities parsed from `Co-authored-by:` trailers count as commit authors. */
export function notSelfAuthored(f: GateFacts, p: GatePolicy): RuleResult {
  const id = 'not_self_authored'
  const bots = p.botLogins.map((b) => b.toLowerCase())
  if (bots.includes(f.pr.author.toLowerCase())) return rule(id, 'fail', `The pull request was opened by ${f.pr.author}, a bot identity`)
  const commitBots = f.pr.commitAuthors.filter((a) => bots.includes(a.toLowerCase()))
  if (commitBots.length > 0) return rule(id, 'fail', `Commits include ${[...new Set(commitBots)].join(', ')}, a bot identity`)
  return rule(id, 'pass', `Author ${f.pr.author} and ${f.pr.commitAuthors.length} commit author(s) are human`)
}

function noPathsIn(id: RuleId, f: GateFacts, patterns: string[], label: string): RuleResult {
  const hits = touchedPaths(f.files)
    .map((t) => ({ path: t.path, pattern: matchesAny(t.path, patterns) }))
    .filter((h) => h.pattern)
  if (hits.length > 0) return rule(id, 'fail', `Changes ${label}: ${hits.map((h) => h.path).join(', ')}`, { hits })
  return rule(id, 'pass', `No ${label} touched`)
}

export function noCiConfigChanges(f: GateFacts, p: GatePolicy): RuleResult {
  return noPathsIn('no_ci_config_changes', f, [...CI_CONFIG_FLOOR, ...p.ciConfigPaths], 'CI configuration')
}

export function noPolicyChanges(f: GateFacts, p: GatePolicy): RuleResult {
  return noPathsIn('no_policy_changes', f, [...POLICY_FLOOR, ...p.policyPaths], 'review policy files')
}

export function noOpaqueFiles(f: GateFacts): RuleResult {
  const id = 'no_opaque_files'
  const opaque = f.files.filter((x) => x.binary || x.mode === '120000' || x.mode === '160000')
  if (opaque.length === 0) return rule(id, 'pass', 'No binary files, symlinks or submodules')
  const label = (x: (typeof opaque)[number]) => `${x.path} (${x.binary ? 'binary' : x.mode === '120000' ? 'symlink' : 'submodule'})`
  return rule(id, 'fail', `Cannot be read as text: ${opaque.map(label).join(', ')}`, { files: opaque.map((x) => normalizePath(x.path).path) })
}

export function categoryInScope(f: GateFacts, p: GatePolicy): { result: RuleResult; category: GateResult['category']; reasons: string[] } {
  const id = 'category_in_scope'
  const { category, reasons } = classifyChange(f.files, p.linkAllowlist)
  const inScope =
    category === 'docs_and_tests'
      ? p.autoApproveScope.includes('docs') && p.autoApproveScope.includes('tests')
      : category !== 'other' && p.autoApproveScope.includes(category)
  const scope = p.autoApproveScope.join(', ') || 'nothing'
  const why = reasons.length > 0 ? `: ${reasons[0]}` : ''
  const result = inScope ? rule(id, 'pass', `Category ${category} is in scope (${scope})`) : rule(id, 'fail', `Category ${category} is outside the auto-approve scope (${scope})${why}`, { category, reasons })
  return { result, category, reasons }
}

export function evaluateGate(facts: GateFacts, policy: GatePolicy): GateResult {
  const cat = categoryInScope(facts, policy)
  const rules: RuleResult[] = [
    boundToCurrentHead(facts),
    ciGreenAtHead(facts, policy),
    requiredReviewersApproved(facts, policy),
    noProtectedPaths(facts, policy),
    withinSizeLimits(facts, policy),
    notSelfAuthored(facts, policy),
    noCiConfigChanges(facts, policy),
    noPolicyChanges(facts, policy),
    noOpaqueFiles(facts),
    cat.result,
  ]
  const failed = rules.filter((r) => r.status === 'fail').map((r) => r.id)
  const unknown = rules.filter((r) => r.status === 'unknown').map((r) => r.id)
  return {
    policyVersion: POLICY_VERSION,
    category: cat.category,
    categoryReasons: cat.reasons,
    rules,
    passed: failed.length === 0 && unknown.length === 0,
    failed,
    unknown,
  }
}
