import { describe, expect, it } from 'vitest'
import { computeReadiness, deriveRunStatus, layerOf, rerunSet, transitiveDependents, type GraphJob, type JobStatus } from './graph.js'

const job = (key: string, status: JobStatus, needs: string[] = []): GraphJob => ({ key, status, needs })

describe('computeReadiness', () => {
  it('a job with no needs is ready', () => {
    expect(computeReadiness([job('a', 'blocked')]).ready).toEqual(['a'])
  })

  it('stays blocked until every prerequisite succeeded', () => {
    const jobs = [job('a', 'success'), job('b', 'running'), job('c', 'blocked', ['a', 'b'])]
    expect(computeReadiness(jobs)).toEqual({ ready: [], skip: [] })
    jobs[1].status = 'success'
    expect(computeReadiness(jobs).ready).toEqual(['c'])
  })

  it('only ever looks at blocked jobs, so a second pass cannot enqueue twice', () => {
    const jobs = [job('a', 'success'), job('b', 'queued', ['a'])]
    expect(computeReadiness(jobs).ready).toEqual([])
  })

  it('skips with a reason when a prerequisite failed', () => {
    const { skip } = computeReadiness([job('a', 'failure'), job('b', 'blocked', ['a'])])
    expect(skip).toEqual([{ key: 'b', reason: 'Needs "a", which failed' }])
  })

  it('skips when a prerequisite was cancelled, or skipped, saying which', () => {
    expect(computeReadiness([job('a', 'cancelled'), job('b', 'blocked', ['a'])]).skip[0].reason).toContain('was cancelled')
    expect(computeReadiness([job('a', 'skipped'), job('b', 'blocked', ['a'])]).skip[0].reason).toContain('was skipped')
  })

  it('a failure wins over an unfinished sibling: no need to wait for it', () => {
    const { skip, ready } = computeReadiness([job('a', 'failure'), job('b', 'running'), job('c', 'blocked', ['a', 'b'])])
    expect(skip).toHaveLength(1)
    expect(ready).toEqual([])
  })

  it('a dependent of a needs_attention job stays blocked: the outcome is not known yet', () => {
    expect(computeReadiness([job('deploy', 'needs_attention'), job('smoke', 'blocked', ['deploy'])])).toEqual({ ready: [], skip: [] })
  })

  it('cascades a skip through repeated passes', () => {
    const jobs = [job('a', 'failure'), job('b', 'blocked', ['a']), job('c', 'blocked', ['b'])]
    const first = computeReadiness(jobs)
    expect(first.skip.map((s) => s.key)).toEqual(['b'])
    jobs[1].status = 'skipped'
    expect(computeReadiness(jobs).skip[0]).toEqual({ key: 'c', reason: 'Needs "b", which was skipped' })
  })
})

describe('deriveRunStatus', () => {
  it('reports success only when everything succeeded', () => {
    expect(deriveRunStatus([job('a', 'success')], true)).toBe('success')
    expect(deriveRunStatus([job('a', 'success'), job('b', 'failure')], true)).toBe('failure')
  })

  it('needs_attention outranks a running sibling', () => {
    expect(deriveRunStatus([job('a', 'needs_attention'), job('b', 'running')], true)).toBe('needs_attention')
  })

  it('waiting shows only once nothing else can move', () => {
    expect(deriveRunStatus([job('a', 'waiting'), job('b', 'running')], true)).toBe('running')
    expect(deriveRunStatus([job('a', 'waiting'), job('b', 'success')], true)).toBe('waiting')
  })

  it('queued until the first claim', () => {
    expect(deriveRunStatus([job('a', 'queued')], false)).toBe('queued')
    expect(deriveRunStatus([job('a', 'queued')], true)).toBe('running')
  })

  it('cancelled and skipped-only runs', () => {
    expect(deriveRunStatus([job('a', 'cancelled'), job('b', 'skipped')], true)).toBe('cancelled')
    expect(deriveRunStatus([job('a', 'skipped')], true)).toBe('failure')
  })
})

describe('re-run sets', () => {
  const dag = [job('a', 'success'), job('b', 'failure', ['a']), job('c', 'skipped', ['b']), job('d', 'success', ['a']), job('e', 'skipped', ['c', 'd'])]

  it('finds transitive dependents', () => {
    expect(transitiveDependents(dag, ['b']).sort()).toEqual(['c', 'e'])
    expect(transitiveDependents(dag, ['a']).sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(transitiveDependents(dag, ['e'])).toEqual([])
  })

  it('re-run job resets the job and everything downstream', () => {
    expect(rerunSet(dag, 'job', 'd').sort()).toEqual(['d', 'e'])
  })

  it('re-run failed resets failed, cancelled and skipped, and leaves successes alone', () => {
    expect(rerunSet(dag, 'failed').sort()).toEqual(['b', 'c', 'e'])
  })

  it('re-run all resets everything', () => {
    expect(rerunSet(dag, 'all')).toHaveLength(5)
  })
})

describe('layerOf', () => {
  it('places a job after its deepest prerequisite', () => {
    const layers = layerOf([job('a', 'success'), job('b', 'success', ['a']), job('c', 'success', ['a', 'b']), job('d', 'success')])
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2, d: 0 })
  })
})
