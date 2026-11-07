import { describe, expect, it } from 'vitest'
import { agreement, isSpotCheck } from './agreement.js'
import { CallStats, Chaos } from './chaos.js'
import { canonicalJson, caseHash, diffCases, nextCaseKey, versionHash } from './dataset-diff.js'
import { extractVariables, missingVariables, renderTemplate } from './template.js'

describe('dataset diff', () => {
  const v1 = [
    { caseKey: 't-001', input: { ticket: 'charged twice' }, reference: 'billing', tags: ['easy'] },
    { caseKey: 't-002', input: { ticket: 'app crashes' }, reference: 'technical', tags: ['easy'] },
    { caseKey: 't-003', input: { ticket: 'hello' }, reference: 'other', tags: [] },
  ]
  const v2 = [
    { caseKey: 't-001', input: { ticket: 'charged twice' }, reference: 'billing', tags: ['easy'] },
    { caseKey: 't-002', input: { ticket: 'app crashes' }, reference: 'account', tags: ['hard'] },
    { caseKey: 't-004', input: { ticket: 'parcel lost' }, reference: 'shipping', tags: [] },
  ]

  it('finds added, removed and modified cases with the changed fields', () => {
    const d = diffCases(v1, v2)
    expect(d.added.map((c) => c.caseKey)).toEqual(['t-004'])
    expect(d.removed.map((c) => c.caseKey)).toEqual(['t-003'])
    expect(d.modified).toHaveLength(1)
    expect(d.modified[0].fields).toEqual(['reference', 'tags'])
    expect(d.unchanged).toBe(1)
  })

  it('hashes content, not key order or tag order', () => {
    expect(caseHash({ input: { a: 1, b: 2 }, reference: 'x', tags: ['p', 'q'] })).toBe(caseHash({ input: { b: 2, a: 1 }, reference: 'x', tags: ['q', 'p'] }))
    expect(caseHash(v1[1])).not.toBe(caseHash(v2[1]))
    expect(versionHash(v1)).toBe(versionHash([...v1].reverse()))
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}')
  })

  it('assigns the next key in sequence', () => {
    expect(nextCaseKey(['t-001', 't-024', 't-007'], 't')).toBe('t-025')
    expect(nextCaseKey([], 'c')).toBe('c-001')
  })
})

describe('template', () => {
  it('extracts, renders and validates variables', () => {
    expect(extractVariables('You are {{ role }}', 'Ticket: {{ticket}} {{role}}')).toEqual(['role', 'ticket'])
    expect(renderTemplate('Ticket: {{ticket}}', { ticket: 'help' })).toBe('Ticket: help')
    expect(missingVariables(['ticket', 'lang'], { ticket: 'x' })).toEqual(['lang'])
  })
})

describe('chaos switches', () => {
  it('consumes armed counts in a fixed order, then stops', () => {
    const c = new Chaos()
    c.arm({ timeout: 1, rate_limit: 2 })
    expect([c.next(), c.next(), c.next(), c.next()]).toEqual(['rate_limit', 'rate_limit', 'timeout', null])
    expect(c.fired.rate_limit).toBe(2)
  })

  it('applies rates after armed counts', () => {
    const c = new Chaos()
    c.setRates({ overloaded: 1 })
    expect(c.next(() => 0.5)).toBe('overloaded')
    c.reset()
    expect(c.next()).toBeNull()
  })

  it('counts calls per run, with peak concurrency', () => {
    const s = new CallStats()
    const done1 = s.start('run_a')
    const done2 = s.start('run_a')
    s.start('run_b')()
    done1()
    done2()
    done2()
    const snap = s.snapshot('run_a')
    expect(s.total).toBe(3)
    expect(snap.run).toMatchObject({ calls: 2, active: 0, maxActive: 2 })
  })
})

describe('agreement', () => {
  it('computes rate and Cohen kappa', () => {
    const pairs = [
      ...Array.from({ length: 20 }, () => ({ judgePassed: true, humanPassed: true })),
      ...Array.from({ length: 5 }, () => ({ judgePassed: true, humanPassed: false })),
      ...Array.from({ length: 10 }, () => ({ judgePassed: false, humanPassed: true })),
      ...Array.from({ length: 15 }, () => ({ judgePassed: false, humanPassed: false })),
    ]
    const a = agreement(pairs)
    // po = 0.7; pj = 0.5, ph = 0.6 → pe = 0.5 → kappa 0.4
    expect(a.rate).toBeCloseTo(0.7, 10)
    expect(a.kappa).toBeCloseTo(0.4, 10)
    expect(agreement([]).rate).toBeNull()
  })

  it('picks a stable spot-check slice', () => {
    const ids = Array.from({ length: 800 }, (_, i) => `cr_${i}`)
    const picked = ids.filter((id) => isSpotCheck(id)).length
    expect(picked).toBeGreaterThan(60)
    expect(picked).toBeLessThan(140)
    expect(isSpotCheck('cr_42')).toBe(isSpotCheck('cr_42'))
  })
})
