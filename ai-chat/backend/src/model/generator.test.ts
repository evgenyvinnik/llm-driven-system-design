import { describe, expect, it } from 'vitest'
import { findModel } from '../shared/catalog.js'
import { extractKeywords, planGeneration, tokenize } from './generator.js'

const swift = findModel('sim-swift')!
const deep = findModel('sim-deep')!
const noFailures = { failureRate: 0, disconnectRate: 0 }
const ask = (content: string) => [{ role: 'user' as const, content }]

describe('planGeneration', () => {
  it('is deterministic for the same context and nonce', () => {
    const req = { model: 'sim-swift', messages: ask('How do I store sourdough starter?'), maxTokens: 600, nonce: 'g1' }
    expect(planGeneration(req, swift, noFailures).tokens.join('')).toBe(
      planGeneration(req, swift, noFailures).tokens.join(''),
    )
  })

  it('gives a regeneration (a new nonce) a different answer', () => {
    const outputs = new Set(
      ['g1', 'g2', 'g3', 'g4'].map(
        (nonce) =>
          planGeneration({ model: 'sim-swift', messages: ask('Plan a picnic'), maxTokens: 600, nonce }, swift, noFailures)
            .tokens.join(''),
      ),
    )
    expect(outputs.size).toBeGreaterThan(1)
  })

  it('stops at maxTokens with finish reason "length"', () => {
    const plan = planGeneration({ model: 'sim-swift', messages: ask('Explain tides'), maxTokens: 5, nonce: 'n' }, swift, noFailures)
    expect(plan.tokens).toHaveLength(5)
    expect(plan.finishReason).toBe('length')
  })

  it('emits fenced code and a table when asked for them', () => {
    const text = planGeneration(
      { model: 'sim-deep', messages: ask('Write a typescript function and compare options in a table'), maxTokens: 2000, nonce: 'n' },
      deep,
      noFailures,
    ).tokens.join('')
    expect(text).toContain('```ts')
    expect(text).toMatch(/\| Aspect \|/)
  })

  it('emits hostile markup when the question is about XSS, for the client to neutralize', () => {
    const text = planGeneration(
      { model: 'sim-swift', messages: ask('How do I prevent XSS in model output?'), maxTokens: 2000, nonce: 'n' },
      swift,
      noFailures,
    ).tokens.join('')
    expect(text).toContain('<script>')
    expect(text).toContain('javascript:')
    expect(text).toContain('![status badge](https://')
  })

  it('schedules an error partway through when the failure rate is 1, without changing the text', () => {
    const req = { model: 'sim-swift', messages: ask('Explain the water cycle'), maxTokens: 600, nonce: 'n' }
    const failing = planGeneration(req, swift, { failureRate: 1, disconnectRate: 0 })
    expect(failing.failAfterToken).not.toBeNull()
    expect(failing.failAfterToken!).toBeLessThan(failing.tokens.length)
    expect(failing.tokens.join('')).toBe(planGeneration(req, swift, noFailures).tokens.join(''))
  })

  it('schedules a silent disconnect when the disconnect rate is 1', () => {
    const plan = planGeneration(
      { model: 'sim-swift', messages: ask('Explain the water cycle'), maxTokens: 600, nonce: 'n' },
      swift,
      { failureRate: 0, disconnectRate: 1 },
    )
    expect(plan.disconnectAfterToken).not.toBeNull()
    expect(plan.failAfterToken).toBeNull()
  })

  it('refers back to earlier topics in a follow-up', () => {
    const messages = [
      { role: 'user' as const, content: 'Tell me about lighthouses' },
      { role: 'assistant' as const, content: 'Lighthouses guide ships.' },
      { role: 'user' as const, content: 'What about foghorns?' },
    ]
    const texts = ['a', 'b', 'c', 'd', 'e', 'f'].map((nonce) =>
      planGeneration({ model: 'sim-swift', messages, maxTokens: 600, nonce }, swift, noFailures).tokens.join(''),
    )
    expect(texts.some((t) => t.includes('lighthouses'))).toBe(true)
  })
})

describe('tokenize', () => {
  it('round-trips the text, including newlines inside code', () => {
    const text = 'Here:\n\n```ts\nconst a = 1\n```\n\n- one\n- two'
    expect(tokenize(text).join('')).toBe(text)
  })
})

describe('extractKeywords', () => {
  it('ignores stopwords and falls back when nothing is left', () => {
    expect(extractKeywords('How do I fix the bicycle chain?')).toEqual(['bicycle', 'chain', 'fix'])
    expect(extractKeywords('is it?')).toEqual(['the question', 'the context'])
  })
})

describe('first messages', () => {
  it('never claims to build on an earlier turn that does not exist', () => {
    for (const nonce of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const text = planGeneration(
        { model: 'sim-swift', messages: ask('Plan a three day trip to Kyoto'), maxTokens: 600, nonce },
        swift,
        noFailures,
      ).tokens.join('')
      expect(text).not.toMatch(/Building on what we said|Picking up from/)
    }
  })
})
