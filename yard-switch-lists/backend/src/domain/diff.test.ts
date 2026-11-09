import { describe, expect, it } from 'vitest'
import { assemble, classify, goodPlan, resetClock } from '../test-support/fixtures.js'
import { countDisturbed, diffMoves, lisLength } from './diff.js'
import { applyOps } from './edit-ops.js'

describe('diff', () => {
  it('finds nothing between a list and itself', () => {
    const plan = goodPlan()
    expect(countDisturbed(plan, plan)).toMatchObject({ kept: 4, changed: 0, reordered: 0, added: 0, removed: 0, disturbed: 0 })
  })

  it('counts one drag as one reorder, not every move it shifted', () => {
    const [a, b, c, d] = goodPlan()
    expect(countDisturbed([a, b, c, d], [d, a, b, c]).reordered).toBe(1)
  })

  it('tells changed, added and removed apart', () => {
    const [a, b, c, d] = goodPlan()
    resetClock()
    const added = classify('new', ['c9'], 'C9', 'A')
    const { counts, changes } = diffMoves([a, b, c, d], [{ ...a, toTrackId: 'C9' }, b, c, added])
    expect(counts).toMatchObject({ changed: 1, added: 1, removed: 1, disturbed: 3 })
    expect(changes.find((x) => x.key === a.key)?.fields).toEqual(['toTrack'])
    expect(changes.find((x) => x.key === d.key)?.type).toBe('removed')
  })

  it('reports a time shift without calling the move changed', () => {
    const plan = goodPlan()
    const later = plan.map((m) => ({ ...m, plannedStart: m.plannedStart + 180 * 60_000 }))
    const counts = countDisturbed(plan, later)
    expect(counts.disturbed).toBe(0)
    expect(counts.retimed).toBe(4)
  })

  it('ignores frozen keys', () => {
    const [a, b] = goodPlan()
    expect(countDisturbed([a, b], [{ ...a, toTrackId: 'C9' }, b], new Set([a.key])).changed).toBe(0)
  })

  it('computes the longest increasing subsequence', () => {
    expect(lisLength([3, 1, 2, 5, 4])).toBe(3)
    expect(lisLength([])).toBe(0)
  })
})

describe('edit operations', () => {
  it('reorders and pins the dragged move ahead of its new neighbour', () => {
    const [a, b, c] = goodPlan()
    const { moves, moved, pins } = applyOps([a, b, c], [{ op: 'reorder', moveKey: b.key, toIndex: 0 }])
    expect(moves.map((m) => m.key)).toEqual([b.key, a.key, c.key])
    expect(moved.has(b.key)).toBe(true)
    expect(pins).toEqual([{ before: b.key, after: a.key }])
  })

  it('retargets a cut and moves the later pull to match', () => {
    resetClock()
    const cut = classify('k', ['c1'], 'C1', 'A')
    const pull = assemble('p', ['c1'], 'C1', 'D1', 'A')
    const { moves } = applyOps([cut, pull], [{ op: 'retarget', moveKey: 'k', toTrackId: 'C9' }])
    expect(moves[0].toTrackId).toBe('C9')
    expect(moves[1].fromTrackId).toBe('C9')
  })

  it('throws on an unknown move', () => {
    expect(() => applyOps(goodPlan(), [{ op: 'reorder', moveKey: 'nope', toIndex: 0 }])).toThrow()
  })
})
