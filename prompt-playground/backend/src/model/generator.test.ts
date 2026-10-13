import { describe, expect, it } from 'vitest'
import { findModel } from '../shared/catalog.js'
import { extractKeywords, planGeneration, tokenize } from './generator.js'

const fast = findModel('sim-fast')!
const base = { model: 'sim-fast', system: 'You triage tickets.', input: 'Billing invoices show double charges', topP: 1, maxTokens: 512 }

describe('planGeneration', () => {
  it('is deterministic at temperature 0 regardless of nonce', () => {
    const a = planGeneration({ ...base, temperature: 0 }, fast, 'nonce-a', 0)
    const b = planGeneration({ ...base, temperature: 0 }, fast, 'nonce-b', 0)
    expect(a.tokens.join('')).toBe(b.tokens.join(''))
  })

  it('varies with the nonce when temperature is above 0', () => {
    const outputs = new Set(
      ['a', 'b', 'c', 'd'].map((n) => planGeneration({ ...base, temperature: 1 }, fast, n, 0).tokens.join('')),
    )
    expect(outputs.size).toBeGreaterThan(1)
  })

  it('stops at maxTokens with finish reason "length"', () => {
    const plan = planGeneration({ ...base, temperature: 0, maxTokens: 5 }, fast, 'n', 0)
    expect(plan.tokens).toHaveLength(5)
    expect(plan.finishReason).toBe('length')
  })

  it('injects a failure partway through when the failure rate is 1', () => {
    const plan = planGeneration({ ...base, temperature: 0 }, fast, 'n', 1)
    expect(plan.failAfterToken).not.toBeNull()
    expect(plan.failAfterToken!).toBeLessThan(plan.tokens.length)
    expect(planGeneration({ ...base, temperature: 0 }, fast, 'n', 0).failAfterToken).toBeNull()
  })

  it('mentions prompt keywords so outputs track the prompt', () => {
    const text = planGeneration({ ...base, temperature: 0 }, fast, 'n', 0).tokens.join('')
    expect(text).toMatch(/billing|invoices|double|charges/)
  })
})

describe('helpers', () => {
  it('tokenize keeps whitespace so tokens rejoin to the original', () => {
    const text = 'Hello there,\n\nworld  again'
    expect(tokenize(text).join('')).toBe(text)
  })

  it('extractKeywords drops stopwords and falls back when empty', () => {
    expect(extractKeywords('the and of')).toEqual(['the request', 'the context'])
    expect(extractKeywords('Refund refund policy')).toEqual(['refund', 'policy'])
  })
})
