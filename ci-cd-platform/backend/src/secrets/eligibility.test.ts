import { describe, expect, it } from 'vitest'
import { decideSecretRelease, evaluateEnvironmentGate, isProtected, type EnvironmentRules, type GateDecision, type RunContext, type SecretCandidate } from './eligibility.js'

const push: RunContext = { isFork: false, branch: 'main', eventType: 'push' }
const featurePush: RunContext = { isFork: false, branch: 'feature/x', eventType: 'push' }
const forkPr: RunContext = { isFork: true, branch: 'patch-1', eventType: 'pull_request' }
const prod: EnvironmentRules = { name: 'production', requiredApproval: true, allowedBranches: ['main'] }
const staging: EnvironmentRules = { name: 'staging', requiredApproval: false, allowedBranches: [] }
const allow: GateDecision = { action: 'allow' }

const candidates: SecretCandidate[] = [
  { id: 's1', name: 'NPM_TOKEN', environment: null },
  { id: 's2', name: 'DEPLOY_TOKEN', environment: 'production' },
  { id: 's3', name: 'SHARED', environment: null },
  { id: 's4', name: 'SHARED', environment: 'production' },
]

describe('evaluateEnvironmentGate', () => {
  it('a job with no environment is always allowed', () => {
    expect(evaluateEnvironmentGate(forkPr, null, null, null)).toEqual({ action: 'allow' })
  })

  it('holds a protected job until it is approved', () => {
    expect(evaluateEnvironmentGate(push, 'production', prod, null).action).toBe('wait')
    expect(evaluateEnvironmentGate(push, 'production', prod, 'approved').action).toBe('allow')
  })

  it('a rejection denies', () => {
    const d = evaluateEnvironmentGate(push, 'production', prod, 'rejected')
    expect(d).toMatchObject({ action: 'deny', code: 'ENV_REJECTED' })
  })

  it('a fork can never enter a protected environment, even with an approval on the row', () => {
    expect(evaluateEnvironmentGate(forkPr, 'production', prod, null)).toMatchObject({ action: 'deny', code: 'ENV_FORK_FORBIDDEN' })
    expect(evaluateEnvironmentGate(forkPr, 'production', prod, 'approved')).toMatchObject({ action: 'deny', code: 'ENV_FORK_FORBIDDEN' })
  })

  it('a fork may enter an unprotected environment', () => {
    expect(evaluateEnvironmentGate(forkPr, 'staging', staging, null).action).toBe('allow')
  })

  it('enforces the branch restriction before asking anyone to approve', () => {
    expect(evaluateEnvironmentGate(featurePush, 'production', prod, null)).toMatchObject({ action: 'deny', code: 'ENV_BRANCH_FORBIDDEN' })
    expect(evaluateEnvironmentGate(featurePush, 'production', prod, 'approved')).toMatchObject({ action: 'deny', code: 'ENV_BRANCH_FORBIDDEN' })
  })

  it('branch patterns work', () => {
    const rel: EnvironmentRules = { name: 'r', requiredApproval: false, allowedBranches: ['release/*'] }
    expect(evaluateEnvironmentGate({ ...push, branch: 'release/1.0' }, 'r', rel, null).action).toBe('allow')
  })

  it('denies an environment that is not configured', () => {
    expect(evaluateEnvironmentGate(push, 'ghost', null, null)).toMatchObject({ action: 'deny', code: 'ENV_NOT_CONFIGURED' })
  })

  it('knows what protected means', () => {
    expect(isProtected(prod)).toBe(true)
    expect(isProtected(staging)).toBe(false)
    expect(isProtected({ ...staging, allowedBranches: ['main'] })).toBe(true)
  })
})

describe('decideSecretRelease', () => {
  it('a fork gets nothing at all, whatever the gate says', () => {
    const d = decideSecretRelease(forkPr, null, allow, ['NPM_TOKEN', 'DEPLOY_TOKEN'], candidates)
    expect(d.release).toEqual([])
    expect(d.withheld.map((w) => w.name)).toEqual(['NPM_TOKEN', 'DEPLOY_TOKEN'])
    expect(d.withheld[0].reason).toContain('forks')
    expect(decideSecretRelease(forkPr, 'production', allow, ['DEPLOY_TOKEN'], candidates).release).toEqual([])
  })

  it('a same-repository push gets the repository secrets it asks for', () => {
    expect(decideSecretRelease(push, null, allow, ['NPM_TOKEN'], candidates).release.map((s) => s.id)).toEqual(['s1'])
  })

  it('gets only what it names', () => {
    expect(decideSecretRelease(push, null, allow, [], candidates)).toEqual({ release: [], withheld: [] })
  })

  it('an environment secret goes only to a job in that environment', () => {
    expect(decideSecretRelease(push, 'production', allow, ['DEPLOY_TOKEN'], candidates).release.map((s) => s.id)).toEqual(['s2'])
    const outside = decideSecretRelease(push, null, allow, ['DEPLOY_TOKEN'], candidates)
    expect(outside.release).toEqual([])
    expect(outside.withheld[0].reason).toContain('environment this job is not in')
    expect(decideSecretRelease(push, 'staging', allow, ['DEPLOY_TOKEN'], candidates).release).toEqual([])
  })

  it('nothing is released while the gate is closed', () => {
    const wait: GateDecision = { action: 'wait', reason: 'x' }
    expect(decideSecretRelease(push, 'production', wait, ['DEPLOY_TOKEN', 'NPM_TOKEN'], candidates).release).toEqual([])
    const deny: GateDecision = { action: 'deny', code: 'x', reason: 'x' }
    expect(decideSecretRelease(push, 'production', deny, ['NPM_TOKEN'], candidates).release).toEqual([])
  })

  it('an environment secret shadows a repository secret of the same name', () => {
    expect(decideSecretRelease(push, 'production', allow, ['SHARED'], candidates).release.map((s) => s.id)).toEqual(['s4'])
    expect(decideSecretRelease(push, null, allow, ['SHARED'], candidates).release.map((s) => s.id)).toEqual(['s3'])
  })

  it('reports a name that does not exist', () => {
    expect(decideSecretRelease(push, null, allow, ['GHOST'], candidates).withheld).toEqual([{ name: 'GHOST', reason: 'No secret with this name exists' }])
  })
})
