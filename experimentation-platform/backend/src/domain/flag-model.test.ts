import { describe, expect, it } from 'vitest'
import { allocateStable } from '../shared/evaluation.js'
import { canTransition, checkConfigReferences, describeConfigChange, initialWeights, killTarget, defaultVariants, updateConfigSchema } from './flag-model.js'

describe('status machine', () => {
  it('allows draft → running → paused ⇄ running → stopped and nothing out of stopped', () => {
    expect(canTransition('draft', 'running')).toBe(true)
    expect(canTransition('running', 'paused')).toBe(true)
    expect(canTransition('paused', 'running')).toBe(true)
    expect(canTransition('running', 'stopped')).toBe(true)
    expect(canTransition('stopped', 'running')).toBe(false)
    expect(canTransition('draft', 'paused')).toBe(false)
    expect(canTransition('paused', 'draft')).toBe(false)
  })
  it('kill switch forces a flag off (resumable) and stops an experiment (final)', () => {
    expect(killTarget('flag')).toBe('paused')
    expect(killTarget('experiment')).toBe('stopped')
  })
})

describe('defaults', () => {
  it('starts flags at 0% on and experiments at an even split', () => {
    expect(initialWeights('flag', defaultVariants('flag'))).toEqual({ on: 0 })
    expect(initialWeights('experiment', defaultVariants('experiment'))).toEqual({ control: 5000, treatment: 5000 })
    const three = [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }, { key: 'c', name: 'C' }]
    expect(Object.values(initialWeights('experiment', three)).reduce((x, y) => x + y)).toBe(10_000)
  })
})

describe('config validation', () => {
  const variants = defaultVariants('experiment')
  it('rejects unknown variants in weights or forced rules, and duplicate rule ids', () => {
    expect(checkConfigReferences(variants, { control: 5000, bogus: 1 }, [])).toMatch(/unknown variant "bogus"/)
    expect(checkConfigReferences(variants, undefined, [{ id: 'r', description: '', conditions: [], action: { type: 'force', variant: 'nope' } }])).toMatch(/forces unknown/)
    const rule = { id: 'r', description: '', conditions: [], action: { type: 'enroll' as const } }
    expect(checkConfigReferences(variants, undefined, [rule, rule])).toMatch(/duplicate rule id/)
    expect(checkConfigReferences(variants, { control: 5000, treatment: 5000 }, [rule])).toBeNull()
  })
  it('validates request bodies strictly', () => {
    expect(updateConfigSchema.safeParse({ weights: { control: 10_001 } }).success).toBe(false)
    expect(updateConfigSchema.safeParse({ weights: { control: 5000 }, extra: 1 }).success).toBe(false)
    expect(updateConfigSchema.safeParse({ rules: [{ id: 'us', conditions: [{ attribute: 'country', operator: 'in', values: ['US'] }], action: { type: 'enroll' } }] }).success).toBe(true)
  })
})

describe('describeConfigChange', () => {
  it('summarizes a ramp with the exact share of units that move', () => {
    const v1 = allocateStable({}, { control: 9000, treatment: 1000 })
    const v2 = allocateStable(v1, { control: 8000, treatment: 2000 })
    const summary = describeConfigChange({ allocation: v1, rules: [], fallthrough: 'enroll' }, { allocation: v2, rules: [], fallthrough: 'enroll' })
    expect(summary).toBe('weights control 90%→80%, treatment 10%→20% (moves 10% of units: control→treatment 10%)')
  })
  it('reports rule and fallthrough changes and no-ops', () => {
    const a = allocateStable({}, { control: 5000, treatment: 5000 })
    const rule = { id: 'r', description: '', conditions: [], action: { type: 'exclude' as const } }
    expect(describeConfigChange({ allocation: a, rules: [], fallthrough: 'enroll' }, { allocation: a, rules: [rule], fallthrough: 'exclude' })).toBe('targeting 0→1 rules; fallthrough enroll→exclude')
    expect(describeConfigChange({ allocation: a, rules: [], fallthrough: 'enroll' }, { allocation: a, rules: [], fallthrough: 'enroll' })).toBe('no effective change')
  })
})
