/**
 * Who may have which secret, and who may enter which environment. Pure, and
 * called from the claim path: this is the enforcement point, and the UI only
 * reflects it. A fork pull request runs code the repository's maintainers have
 * not reviewed, so everything here starts from "the fork gets nothing".
 * @module secrets/eligibility
 */
import { branchMatches } from '../workflow/parser.js'

export interface RunContext {
  isFork: boolean
  branch: string
  eventType: string
}

export interface EnvironmentRules {
  name: string
  requiredApproval: boolean
  allowedBranches: string[]
}

export const isProtected = (env: EnvironmentRules) => env.requiredApproval || env.allowedBranches.length > 0

export type GateDecision = { action: 'allow' } | { action: 'wait'; reason: string } | { action: 'deny'; code: string; reason: string }

/**
 * Whether a job may run in its environment right now.
 * @param env the environment's rules, or null if the job names one that isn't configured
 * @param approval this attempt's decision, if any. Approval never carries over to a re-run.
 */
export function evaluateEnvironmentGate(run: RunContext, jobEnvironment: string | null, env: EnvironmentRules | null, approval: 'approved' | 'rejected' | null): GateDecision {
  if (!jobEnvironment) return { action: 'allow' }
  if (!env) return { action: 'deny', code: 'ENV_NOT_CONFIGURED', reason: `Environment "${jobEnvironment}" is not configured for this repository` }
  if (run.isFork && isProtected(env)) {
    return { action: 'deny', code: 'ENV_FORK_FORBIDDEN', reason: `A pull request from a fork cannot enter protected environment "${env.name}"` }
  }
  if (env.allowedBranches.length > 0 && !env.allowedBranches.some((p) => branchMatches(run.branch, p))) {
    return { action: 'deny', code: 'ENV_BRANCH_FORBIDDEN', reason: `Branch "${run.branch}" may not deploy to "${env.name}" (allowed: ${env.allowedBranches.join(', ')})` }
  }
  if (env.requiredApproval) {
    if (approval === 'rejected') return { action: 'deny', code: 'ENV_REJECTED', reason: `Deployment to "${env.name}" was rejected` }
    if (approval !== 'approved') return { action: 'wait', reason: `Waiting for a maintainer to approve deployment to "${env.name}"` }
  }
  return { action: 'allow' }
}

export interface SecretCandidate {
  id: string
  name: string
  /** null for a repository secret; the environment's name for an environment secret. */
  environment: string | null
}

export interface Withheld {
  name: string
  reason: string
}

export interface ReleaseDecision {
  release: SecretCandidate[]
  withheld: Withheld[]
}

/**
 * Decides, per requested name, what a job gets. Least privilege: a job gets only
 * what its workflow names, and an environment secret only when the job is in that
 * environment. An environment secret shadows a repository secret of the same name.
 */
export function decideSecretRelease(run: RunContext, jobEnvironment: string | null, gate: GateDecision, requested: string[], candidates: SecretCandidate[]): ReleaseDecision {
  const release: SecretCandidate[] = []
  const withheld: Withheld[] = []
  for (const name of requested) {
    if (run.isFork) {
      withheld.push({ name, reason: 'Pull requests from forks never receive secrets' })
      continue
    }
    if (gate.action !== 'allow') {
      withheld.push({ name, reason: 'The environment gate has not been passed' })
      continue
    }
    const inEnvironment = jobEnvironment ? candidates.find((c) => c.name === name && c.environment === jobEnvironment) : undefined
    const inRepository = candidates.find((c) => c.name === name && c.environment === null)
    const chosen = inEnvironment ?? inRepository
    if (chosen) release.push(chosen)
    else withheld.push({ name, reason: candidates.some((c) => c.name === name) ? 'Scoped to an environment this job is not in' : 'No secret with this name exists' })
  }
  return { release, withheld }
}
