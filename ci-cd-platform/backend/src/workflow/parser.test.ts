import { describe, expect, it } from 'vitest'
import { branchMatches, findCycle, matchesTrigger, MAX_WORKFLOW_BYTES, parseWorkflow } from './parser.js'

const minimal = `
name: ci
on: [push]
jobs:
  build:
    runs-on: [linux]
    steps:
      - name: Compile
        run: echo hi
`

function errorsOf(source: string) {
  const result = parseWorkflow(source)
  if (result.ok) throw new Error('expected the workflow to be rejected')
  return result.errors
}

describe('parseWorkflow', () => {
  it('parses a minimal workflow and applies defaults', () => {
    const result = parseWorkflow(minimal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [job] = result.workflow.jobs
    expect(job.key).toBe('build')
    expect(job.runsOn).toEqual(['linux'])
    expect(job.steps[0]).toMatchObject({ name: 'Compile', idempotent: true, timeoutSeconds: 60 })
    expect(result.workflow.on.push).toEqual({ branches: null })
  })

  it('reads idempotent: false, environment, secrets and uploads', () => {
    const result = parseWorkflow(`
on: { push: { branches: [main, 'release/*'] } }
jobs:
  deploy:
    runs-on: linux
    environment: production
    secrets: [DEPLOY_TOKEN]
    upload:
      - { name: receipt, path: out/receipt.txt, retention-days: 30 }
    steps:
      - { name: Deploy, run: ./deploy.sh, idempotent: false, timeout-seconds: 120 }
`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [job] = result.workflow.jobs
    expect(job.environment).toBe('production')
    expect(job.secrets).toEqual(['DEPLOY_TOKEN'])
    expect(job.steps[0].idempotent).toBe(false)
    expect(job.steps[0].timeoutSeconds).toBe(120)
    expect(job.uploads[0]).toEqual({ name: 'receipt', path: 'out/receipt.txt', retentionDays: 30 })
    expect(result.workflow.on.push?.branches).toEqual(['main', 'release/*'])
  })

  it('rejects an unknown field in a step, naming it', () => {
    const errors = errorsOf(`
on: [push]
jobs:
  deploy:
    runs-on: [linux]
    steps:
      - { name: Deploy, run: ./deploy.sh, idempotnet: false }
`)
    expect(errors[0].code).toBe('UNKNOWN_FIELD')
    expect(errors[0].message).toContain('idempotnet')
    expect(errors[0].path).toContain('jobs.deploy.steps.0')
  })

  it('rejects unknown fields at the top and on a job', () => {
    expect(errorsOf(`on: [push]\nconcurrency: 3\njobs: { a: { runs-on: x, steps: [{ name: s, run: r }] } }`)[0].code).toBe('UNKNOWN_FIELD')
    expect(errorsOf(`on: [push]\njobs: { a: { runs-on: x, retries: 3, steps: [{ name: s, run: r }] } }`)[0].message).toContain('retries')
  })

  it('rejects a need that is not defined', () => {
    const errors = errorsOf(`on: [push]\njobs: { a: { runs-on: x, needs: [ghost], steps: [{ name: s, run: r }] } }`)
    expect(errors[0].code).toBe('UNKNOWN_NEEDS')
    expect(errors[0].message).toContain('ghost')
  })

  it('rejects a direct cycle and prints the path', () => {
    const errors = errorsOf(`
on: [push]
jobs:
  a: { runs-on: x, needs: [c], steps: [{ name: s, run: r }] }
  b: { runs-on: x, needs: [a], steps: [{ name: s, run: r }] }
  c: { runs-on: x, needs: [b], steps: [{ name: s, run: r }] }
`)
    expect(errors[0].code).toBe('DEPENDENCY_CYCLE')
    expect(errors[0].message).toMatch(/a -> c -> b -> a/)
  })

  it('rejects a job that needs itself', () => {
    expect(errorsOf(`on: [push]\njobs: { a: { runs-on: x, needs: a, steps: [{ name: s, run: r }] } }`)[0].code).toBe('DEPENDENCY_CYCLE')
  })

  it('rejects YAML syntax errors', () => {
    expect(errorsOf('jobs: [unterminated')[0].code).toBe('YAML_SYNTAX')
  })

  it('rejects a job with no steps and a workflow with no jobs', () => {
    expect(errorsOf(`on: [push]\njobs: { a: { runs-on: x, steps: [] } }`)[0].code).toBe('INVALID_FIELD')
    expect(errorsOf(`on: [push]\njobs: {}`)[0].path).toBe('jobs')
  })

  it('rejects an oversized file before parsing it', () => {
    expect(errorsOf('#'.repeat(MAX_WORKFLOW_BYTES + 1))[0].code).toBe('TOO_LARGE')
  })

  it('does not treat a YAML alias bomb as a workflow', () => {
    const bomb = `a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d]\non: [push]\njobs: {}`
    expect(errorsOf(bomb)[0].code).toBe('YAML_SYNTAX')
  })

  it('expands a matrix and makes a dependent need every leg', () => {
    const result = parseWorkflow(`
on: [push]
jobs:
  test:
    runs-on: [linux]
    strategy: { matrix: { node: [18, 20], os: [a, b] } }
    steps: [{ name: s, run: r }]
  publish:
    runs-on: [linux]
    needs: test
    steps: [{ name: s, run: r }]
`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workflow.jobs.map((j) => j.key).sort()).toEqual(['publish', 'test-node-18-os-a', 'test-node-18-os-b', 'test-node-20-os-a', 'test-node-20-os-b'])
    const publish = result.workflow.jobs.find((j) => j.key === 'publish')!
    expect(publish.needs).toHaveLength(4)
    const leg = result.workflow.jobs.find((j) => j.key === 'test-node-20-os-a')!
    expect(leg.env).toMatchObject({ MATRIX_NODE: '20', MATRIX_OS: 'a' })
    expect(leg.name).toBe('test (node=20, os=a)')
  })

  it('accepts a diamond', () => {
    const result = parseWorkflow(`
on: push
jobs:
  a: { runs-on: x, steps: [{ name: s, run: r }] }
  b: { runs-on: x, needs: a, steps: [{ name: s, run: r }] }
  c: { runs-on: x, needs: [a], steps: [{ name: s, run: r }] }
  d: { runs-on: x, needs: [b, c], steps: [{ name: s, run: r }] }
`)
    expect(result.ok).toBe(true)
  })
})

describe('findCycle', () => {
  it('returns null for a DAG and the path for a cycle', () => {
    expect(findCycle([{ key: 'a', needs: [] }, { key: 'b', needs: ['a'] }])).toBeNull()
    expect(findCycle([{ key: 'a', needs: ['b'] }, { key: 'b', needs: ['a'] }])).toEqual(['a', 'b', 'a'])
  })
})

describe('triggers', () => {
  it('matches branch patterns', () => {
    expect(branchMatches('main', 'main')).toBe(true)
    expect(branchMatches('release/1.2', 'release/*')).toBe(true)
    expect(branchMatches('release/1.2/hotfix', 'release/*')).toBe(false)
    expect(branchMatches('release/1.2/hotfix', 'release/**')).toBe(true)
    expect(branchMatches('mainline', 'main')).toBe(false)
  })

  it('matches events and branch filters', () => {
    const wf = { on: { push: { branches: ['main'] }, pull_request: { branches: null } } }
    expect(matchesTrigger(wf, 'push', 'main')).toBe(true)
    expect(matchesTrigger(wf, 'push', 'dev')).toBe(false)
    expect(matchesTrigger(wf, 'pull_request', 'anything')).toBe(true)
    expect(matchesTrigger({ on: { push: { branches: null } } }, 'pull_request', 'x')).toBe(false)
  })
})
