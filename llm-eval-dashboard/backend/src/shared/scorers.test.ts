import { describe, expect, it } from 'vitest'
import { extractJsonCandidate, parseScorerConfig, scoreDeterministic } from './scorers.js'

describe('exact_match', () => {
  it('respects case sensitivity and trimming', () => {
    expect(scoreDeterministic('exact_match', { caseSensitive: true, trim: true }, ' billing\n', 'billing').passed).toBe(true)
    expect(scoreDeterministic('exact_match', { caseSensitive: true, trim: true }, 'Billing', 'billing').passed).toBe(false)
    expect(scoreDeterministic('exact_match', { caseSensitive: false, trim: true }, 'Billing', 'billing').passed).toBe(true)
  })
})

describe('regex', () => {
  const v1 = { pattern: '^{{reference}}$', flags: '' }
  const v2 = { pattern: '(?:^|category:\\s*){{reference}}\\b', flags: 'im' }
  const prose = 'Category: Billing\nReason: The customer mentions a charge.'

  it('v1 only accepts the bare label', () => {
    expect(scoreDeterministic('regex', v1, 'billing', 'billing').passed).toBe(true)
    expect(scoreDeterministic('regex', v1, prose, 'billing').passed).toBe(false)
  })

  it('the fixed v2 accepts "Category: X" in any case, and still rejects the wrong label', () => {
    expect(scoreDeterministic('regex', v2, prose, 'billing').passed).toBe(true)
    expect(scoreDeterministic('regex', v2, 'billing', 'billing').passed).toBe(true)
    expect(scoreDeterministic('regex', v2, 'Category: Account\nReason: billing was mentioned', 'billing').passed).toBe(false)
  })

  it('escapes the reference', () => {
    expect(scoreDeterministic('regex', { pattern: '^{{reference}}$', flags: '' }, 'a+b', 'a+b').passed).toBe(true)
    expect(scoreDeterministic('regex', { pattern: '^{{reference}}$', flags: '' }, 'aab', 'a+b').passed).toBe(false)
  })

  it('rejects an invalid pattern when the version is created', () => {
    expect(() => parseScorerConfig('regex', { pattern: '([a-z' })).toThrow()
  })
})

describe('contains', () => {
  it('is case-insensitive by default', () => {
    expect(scoreDeterministic('contains', { caseSensitive: false }, 'Category: Billing', 'billing').score).toBe(1)
    expect(scoreDeterministic('contains', { caseSensitive: true }, 'Category: Billing', 'billing').score).toBe(0)
  })
})

describe('json_shape', () => {
  const keys = ['product', 'quantity', 'city', 'priority']
  const ref = JSON.stringify({ product: 'notebook', quantity: 12, city: 'Lisbon', priority: 'high' })
  const json = JSON.stringify({ product: 'notebook', quantity: 1, city: 'lisbon', priority: 'high' }, null, 2)
  const fenced = `Here is the extracted order:\n\n\`\`\`json\n${json}\n\`\`\``

  it('gives partial credit per field, comparing strings case-insensitively', () => {
    const r = scoreDeterministic('json_shape', { requiredKeys: keys, compareValues: true, stripFences: false }, json, ref)
    expect(r.score).toBe(0.75)
    expect(r.passed).toBe(false)
    expect(r.rationale).toContain('quantity=1')
  })

  it('v1 cannot parse fenced output; v2 strips fences and prose', () => {
    expect(scoreDeterministic('json_shape', { requiredKeys: keys, compareValues: true, stripFences: false }, fenced, ref).score).toBe(0)
    expect(scoreDeterministic('json_shape', { requiredKeys: keys, compareValues: true, stripFences: true }, fenced, ref).score).toBe(0.75)
  })

  it('reports missing keys and non-objects', () => {
    expect(scoreDeterministic('json_shape', { requiredKeys: keys, compareValues: false, stripFences: false }, '{"product":"x"}', ref).score).toBe(0.25)
    expect(scoreDeterministic('json_shape', { requiredKeys: keys, compareValues: false, stripFences: false }, '[1,2]', ref).passed).toBe(false)
  })

  it('extracts the object from surrounding prose', () => {
    expect(extractJsonCandidate('Sure! {"a": 1} Hope that helps')).toBe('{"a": 1}')
  })
})
