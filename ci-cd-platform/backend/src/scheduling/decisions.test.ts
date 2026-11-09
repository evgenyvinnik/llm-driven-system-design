import { describe, expect, it } from 'vitest'
import { decideCompletion, decideLeaseExpiry, type StepEvidence } from './decisions.js'

const at = new Date('2026-01-01T00:00:00Z')
const step = (name: string, idempotent: boolean, status: StepEvidence['status'], startedAt: Date | null = at): StepEvidence => ({ name, idempotent, status, startedAt })

describe('decideLeaseExpiry', () => {
  it('re-queues when only idempotent steps had started', () => {
    const d = decideLeaseExpiry([step('build', true, 'success'), step('test', true, 'running'), step('deploy', false, 'pending', null)], 0, 2, 'runner-1')
    expect(d.action).toBe('requeue')
  })

  it('needs a human when a non-idempotent step is running', () => {
    const d = decideLeaseExpiry([step('build', true, 'success'), step('deploy', false, 'running')], 0, 2, 'runner-1')
    expect(d.action).toBe('needs_attention')
    if (d.action !== 'needs_attention') return
    expect(d.unsafeSteps).toEqual(['deploy'])
    expect(d.reason).toContain('may have succeeded')
    expect(d.reason).toContain('runner-1')
  })

  it('needs a human when a non-idempotent step already finished: the retry would run it again', () => {
    expect(decideLeaseExpiry([step('deploy', false, 'success'), step('notify', true, 'running')], 0, 2, 'r').action).toBe('needs_attention')
    expect(decideLeaseExpiry([step('deploy', false, 'failure'), step('notify', true, 'running')], 0, 2, 'r').action).toBe('needs_attention')
  })

  it('a non-idempotent step that never started does not block the retry', () => {
    expect(decideLeaseExpiry([step('test', true, 'running'), step('deploy', false, 'pending', null)], 0, 2, 'r').action).toBe('requeue')
    expect(decideLeaseExpiry([step('deploy', false, 'skipped', null)], 0, 2, 'r').action).toBe('requeue')
  })

  it('non-idempotent evidence wins over the retry budget', () => {
    expect(decideLeaseExpiry([step('deploy', false, 'running')], 99, 2, 'r').action).toBe('needs_attention')
  })

  it('stops re-queueing a job that keeps losing its runner', () => {
    expect(decideLeaseExpiry([step('test', true, 'running')], 1, 2, 'r').action).toBe('requeue')
    const d = decideLeaseExpiry([step('test', true, 'running')], 2, 2, 'r')
    expect(d.action).toBe('fail')
    expect(d.reason).toContain('3 lost runners')
  })

  it('names the runner when it is known and copes when it is not', () => {
    expect(decideLeaseExpiry([], 0, 2, null).reason).toContain('the runner')
  })
})

describe('decideCompletion', () => {
  it('passes a normal conclusion through', () => {
    expect(decideCompletion('success', [step('a', false, 'success')], null)).toEqual({ status: 'success', reason: null })
    expect(decideCompletion('failure', [step('a', true, 'failure')], 'exit 1')).toEqual({ status: 'failure', reason: 'exit 1' })
  })

  it('a non-idempotent step that exited non-zero is a plain failure: it told us', () => {
    expect(decideCompletion('failure', [step('deploy', false, 'failure')], 'exit 1').status).toBe('failure')
  })

  it('a non-idempotent step killed by cancel has an unknown outcome', () => {
    const d = decideCompletion('cancelled', [step('deploy', false, 'killed')], null)
    expect(d.status).toBe('needs_attention')
    expect(d.reason).toContain('was killed')
  })

  it('a non-idempotent step that timed out has an unknown outcome', () => {
    const d = decideCompletion('failure', [step('deploy', false, 'timed_out')], 'timeout')
    expect(d.status).toBe('needs_attention')
    expect(d.reason).toContain('timed out')
  })

  it('an idempotent step killed by cancel is just cancelled', () => {
    expect(decideCompletion('cancelled', [step('test', true, 'killed')], null).status).toBe('cancelled')
  })

  it('a runner claiming success while a non-idempotent step is unfinished is not believed', () => {
    expect(decideCompletion('success', [step('deploy', false, 'running')], null).status).toBe('needs_attention')
  })
})
