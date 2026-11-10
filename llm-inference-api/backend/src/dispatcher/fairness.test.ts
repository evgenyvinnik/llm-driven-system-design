import { describe, expect, it } from 'vitest'
import { FairPicker, type TenantQueueView } from './fairness.js'

function queue(orgId: string, n: number, cost = 1000, weight = 1): TenantQueueView {
  return { orgId, weight, heads: Array.from({ length: n }, (_, i) => ({ id: `${orgId}-${i}`, cost })) }
}

describe('deficit round robin', () => {
  it('a quiet tenant is served in the first batch despite a noisy backlog', () => {
    const picker = new FairPicker(1024)
    const picks = picker.pick([queue('noisy', 500), queue('quiet', 2)], 4)
    expect(picks.filter((p) => p.orgId === 'quiet')).toHaveLength(2)
  })

  it('backlogged tenants share dispatches in proportion to weight', () => {
    const picker = new FairPicker(1000)
    const counts: Record<string, number> = { a: 0, b: 0 }
    const pos: Record<string, number> = { a: 0, b: 0 }
    for (let round = 0; round < 50; round++) {
      const views = [
        { orgId: 'a', weight: 3, heads: Array.from({ length: 8 }, (_, i) => ({ id: `a-${pos.a + i}`, cost: 1000 })) },
        { orgId: 'b', weight: 1, heads: Array.from({ length: 8 }, (_, i) => ({ id: `b-${pos.b + i}`, cost: 1000 })) },
      ]
      for (const p of picker.pick(views, 4)) {
        counts[p.orgId]++
        pos[p.orgId]++
      }
    }
    expect(counts.a / counts.b).toBeGreaterThan(2.5)
    expect(counts.a / counts.b).toBeLessThan(3.5)
  })

  it('fairness is by cost: big requests use more credit than small ones', () => {
    const picker = new FairPicker(1000)
    const picks = picker.pick([queue('big', 10, 4000), queue('small', 10, 500)], 6)
    expect(picks.filter((p) => p.orgId === 'small').length).toBeGreaterThan(picks.filter((p) => p.orgId === 'big').length)
  })

  it('keeps FIFO order within a tenant and never exceeds n', () => {
    const picker = new FairPicker(5000)
    const picks = picker.pick([queue('t', 10)], 3)
    expect(picks.map((p) => p.id)).toEqual(['t-0', 't-1', 't-2'])
  })

  it('drops credit when a tenant goes idle', () => {
    const picker = new FairPicker(10_000)
    picker.pick([queue('a', 1)], 4)
    expect(picker.deficits.get('a')).toBe(0)
    picker.pick([queue('b', 1)], 4)
    expect(picker.deficits.has('a')).toBe(false)
  })

  it('a request costing more than one quantum still goes out after enough rounds', () => {
    const picker = new FairPicker(100)
    expect(picker.pick([queue('a', 1, 950)], 1)).toHaveLength(1)
  })
})
