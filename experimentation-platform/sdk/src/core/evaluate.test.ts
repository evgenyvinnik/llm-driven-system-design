import { describe, expect, it } from 'vitest'
import { evaluate, evaluateFlag, resolveUnit } from './evaluate.js'
import { bucketOf } from './hash.js'
import { conditionMatches } from './targeting.js'
import type { Snapshot, SnapshotFlag } from './types.js'

function flag(overrides: Partial<SnapshotFlag> = {}): SnapshotFlag {
  return {
    key: 'checkout_cta',
    kind: 'experiment',
    unitType: 'user',
    salt: 'cta-salt',
    status: 'running',
    version: 3,
    variants: [
      { key: 'control', name: 'Control', value: 'Add to cart' },
      { key: 'treatment', name: 'Treatment', value: 'Buy now' },
    ],
    defaultVariant: 'control',
    rules: [],
    fallthrough: 'enroll',
    allocation: { control: [[0, 5000]], treatment: [[5000, 10_000]] },
    ...overrides,
  }
}

describe('resolveUnit', () => {
  it('buckets user experiments by the stable id, falling back to user then anonymous id', () => {
    expect(resolveUnit('user', { anonymousId: 'a1', userId: 'u1', stableId: 's1' })).toBe('s1')
    expect(resolveUnit('user', { anonymousId: 'a1', userId: 'u1' })).toBe('u1')
    expect(resolveUnit('user', { anonymousId: 'a1' })).toBe('a1')
    expect(resolveUnit('anonymous', { anonymousId: 'a1', userId: 'u1', stableId: 's1' })).toBe('a1')
    expect(resolveUnit('org', { anonymousId: 'a1' })).toBeUndefined()
  })
})

describe('evaluateFlag', () => {
  it('serves the variant owning the unit bucket and marks it in-experiment', () => {
    const f = flag()
    for (let i = 0; i < 200; i++) {
      const id = `u${i}`
      const e = evaluateFlag(f, { stableId: id })
      const bucket = bucketOf('cta-salt', id)
      expect(e.bucket).toBe(bucket)
      expect(e.variant).toBe(bucket < 5000 ? 'control' : 'treatment')
      expect(e.reason).toBe('allocated')
      expect(e.inExperiment).toBe(true)
      expect(e.version).toBe(3)
    }
  })

  it('serves the default, never in-experiment, when not running', () => {
    for (const status of ['draft', 'paused', 'stopped'] as const) {
      const e = evaluateFlag(flag({ status }), { stableId: 'u1' })
      expect(e).toMatchObject({ variant: 'control', reason: 'inactive', inExperiment: false, value: 'Add to cart' })
    }
  })

  it('serves the default to units in unallocated buckets', () => {
    const f = flag({ allocation: { control: [[0, 1000]], treatment: [[1000, 2000]] } })
    let notAllocated = 0
    for (let i = 0; i < 2000; i++) {
      const e = evaluateFlag(f, { stableId: `u${i}` })
      if (e.reason === 'not_allocated') {
        notAllocated++
        expect(e.inExperiment).toBe(false)
        expect(e.variant).toBe('control')
      }
    }
    expect(notAllocated / 2000).toBeGreaterThan(0.75)
  })

  it('applies targeting rules in order: force, exclude, enroll; fallthrough decides the rest', () => {
    const f = flag({
      fallthrough: 'exclude',
      rules: [
        { id: 'qa', description: 'QA', conditions: [{ attribute: 'id', operator: 'in', values: ['qa-1'] }], action: { type: 'force', variant: 'treatment' } },
        { id: 'no-de', description: 'Not DE', conditions: [{ attribute: 'country', operator: 'in', values: ['DE'] }], action: { type: 'exclude' } },
        {
          id: 'us-free',
          description: 'US/CA free web',
          conditions: [
            { attribute: 'country', operator: 'in', values: ['US', 'CA'] },
            { attribute: 'plan', operator: 'in', values: ['free'] },
          ],
          action: { type: 'enroll' },
        },
      ],
    })
    expect(evaluateFlag(f, { stableId: 'qa-1', attributes: { country: 'DE' } })).toMatchObject({ variant: 'treatment', reason: 'forced', inExperiment: false })
    expect(evaluateFlag(f, { stableId: 'x', attributes: { country: 'DE', plan: 'free' } })).toMatchObject({ reason: 'excluded', ruleId: 'no-de' })
    expect(evaluateFlag(f, { stableId: 'x', attributes: { country: 'US', plan: 'pro' } })).toMatchObject({ reason: 'not_targeted', inExperiment: false })
    expect(evaluateFlag(f, { stableId: 'x', attributes: { country: 'CA', plan: 'free' } })).toMatchObject({ reason: 'allocated', ruleId: 'us-free' })
  })

  it('treats missing attributes as not in a list', () => {
    expect(conditionMatches({ attribute: 'country', operator: 'in', values: ['US'] }, {}, 'u')).toBe(false)
    expect(conditionMatches({ attribute: 'country', operator: 'not_in', values: ['US'] }, {}, 'u')).toBe(true)
  })

  it('never marks a flag (as opposed to an experiment) in-experiment', () => {
    const f = flag({ kind: 'flag', allocation: { on: [[0, 10_000]] }, variants: [{ key: 'off', name: 'Off', value: false }, { key: 'on', name: 'On', value: true }], defaultVariant: 'off' })
    expect(evaluateFlag(f, { stableId: 'u1' })).toMatchObject({ variant: 'on', value: true, inExperiment: false, reason: 'allocated' })
  })

  it('reports org experiments without an org as no_unit', () => {
    expect(evaluateFlag(flag({ unitType: 'org' }), { anonymousId: 'a' })).toMatchObject({ reason: 'no_unit', variant: 'control' })
  })
})

describe('evaluate', () => {
  it('returns unknown_flag with no variant for keys missing from the snapshot', () => {
    const snapshot: Snapshot = { schema: 1, environment: 'prod', version: 1, compiledAt: '', flags: {} }
    expect(evaluate(snapshot, 'nope', {})).toMatchObject({ variant: null, reason: 'unknown_flag' })
    expect(evaluate(null, 'nope', {})).toMatchObject({ variant: null, reason: 'unknown_flag' })
  })
})
