/**
 * Types for the deterministic policy gate. Nothing here depends on the
 * database, the network or the model: the gate is a pure function of facts.
 * @module shared/gate/types
 */

export type RepoMode = 'observe' | 'narrow_auto'
export type ChangeCategory = 'docs' | 'tests' | 'docs_and_tests' | 'other'
export type ScopeCategory = 'docs' | 'tests'

export type RuleId =
  | 'bound_to_current_head'
  | 'ci_green_at_head'
  | 'required_reviewers_approved'
  | 'no_protected_paths'
  | 'within_size_limits'
  | 'not_self_authored'
  | 'no_ci_config_changes'
  | 'no_policy_changes'
  | 'no_opaque_files'
  | 'category_in_scope'

/** `unknown` means the facts were missing. It is never treated as a pass. */
export type RuleStatus = 'pass' | 'fail' | 'unknown'

export interface RuleResult {
  id: RuleId
  status: RuleStatus
  reason: string
  evidence?: unknown
}

export interface GateFile {
  path: string
  previousPath: string | null
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  patch: string | null
  binary: boolean
  /** Git file mode: 100644, 100755, 120000 (symlink) or 160000 (submodule). */
  mode: string
}

export interface GateCheck {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped' | null
  headSha: string
}

export interface GateReview {
  user: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  commitId: string
  dismissed: boolean
  submittedAt: string
}

export interface GatePolicy {
  protectedPaths: string[]
  ciConfigPaths: string[]
  policyPaths: string[]
  maxFiles: number
  maxChangedLines: number
  autoApproveScope: ScopeCategory[]
  requiredChecks: string[]
  requiredReviewers: string[]
  botLogins: string[]
  linkAllowlist: string[]
}

export interface GateFacts {
  /** The SHA this decision is about. */
  boundSha: string
  boundBaseRef: string
  pr: {
    state: 'open' | 'closed' | 'merged'
    headSha: string
    baseRef: string
    author: string
    /** The host's own count, so a short file list can be noticed. */
    changedFiles: number
    filesTruncated: boolean
    commitAuthors: string[]
  }
  files: GateFile[]
  /** null means the checks could not be read. */
  checks: GateCheck[] | null
  /** null means the reviews could not be read. */
  reviews: GateReview[] | null
}

export interface GateResult {
  policyVersion: string
  category: ChangeCategory
  categoryReasons: string[]
  rules: RuleResult[]
  /** Every rule is `pass`. */
  passed: boolean
  failed: RuleId[]
  unknown: RuleId[]
}
