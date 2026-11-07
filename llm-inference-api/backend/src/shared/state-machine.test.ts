import { describe, expect, it } from 'vitest'
import { canTransition, isTerminal, sourcesOf, STATUSES } from './state-machine.js'

describe('request state machine', () => {
  it('only queued and running are open', () => {
    expect(STATUSES.filter((s) => !isTerminal(s))).toEqual(['queued', 'running'])
  })

  it('cancel is possible from queued and running, completion only from running', () => {
    expect(sourcesOf('cancelled')).toEqual(['queued', 'running'])
    expect(sourcesOf('completed')).toEqual(['running'])
    expect(sourcesOf('running')).toEqual(['queued'])
  })

  it('terminal states never move, and running never goes back to queued', () => {
    for (const from of ['completed', 'cancelled', 'failed'] as const) {
      for (const to of STATUSES) expect(canTransition(from, to)).toBe(false)
    }
    expect(canTransition('running', 'queued')).toBe(false)
  })

  it('a cancel and a completion cannot both apply: after either, the other has no source', () => {
    for (const first of ['cancelled', 'completed'] as const) {
      const second = first === 'cancelled' ? 'completed' : 'cancelled'
      expect(sourcesOf(second).includes(first)).toBe(false)
    }
  })
})
