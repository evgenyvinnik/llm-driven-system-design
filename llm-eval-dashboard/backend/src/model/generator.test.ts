import { describe, expect, it } from 'vitest'
import { PROMPTS, TRIAGE_V2 } from '../db/seed-data.js'
import { renderTemplate } from '../shared/template.js'
import { sampleSeed } from './catalog.js'
import { planGeneration, type GenerateRequest } from './generator.js'

const pv = (id: string) => PROMPTS.flatMap((p) => p.versions).find((v) => v.id === id)!
const req = (promptId: string, input: Record<string, string>, over: Partial<GenerateRequest> = {}): GenerateRequest => {
  const p = pv(promptId)
  return { model: 'mock-small', system: p.system, prompt: renderTemplate(p.template, input), temperature: 0.7, maxTokens: 160, seed: sampleSeed(29, 0), ...over }
}
const text = (r: ReturnType<typeof planGeneration>) => (r.ok ? r.text : `ERR:${r.errorType}`)
const correct = (promptId: string, cases = TRIAGE_V2, samples = 5) => {
  let ok = 0
  let n = 0
  for (const c of cases) {
    for (let s = 0; s < samples; s++) {
      const r = planGeneration(req(promptId, c.input, { seed: sampleSeed(29, s) }))
      if (!r.ok) continue
      n++
      if (r.text.toLowerCase().includes(c.reference)) ok++
    }
  }
  return ok / n
}

describe('mock model determinism', () => {
  const c = TRIAGE_V2.find((x) => x.caseKey === 't-009')!

  it('is a pure function of (prompt version, case, sample seed)', () => {
    expect(text(planGeneration(req('pv_triage_2', c.input)))).toBe(text(planGeneration(req('pv_triage_2', c.input))))
  })

  it('at temperature 0 every sample is identical, whatever the seed', () => {
    const outs = new Set([0, 1, 2, 3, 4].map((s) => text(planGeneration(req('pv_triage_1', c.input, { temperature: 0, seed: sampleSeed(29, s) })))))
    expect(outs.size).toBe(1)
  })

  it('at temperature > 0 samples of an ambiguous case vary', () => {
    const outs = new Set(Array.from({ length: 12 }, (_, s) => text(planGeneration(req('pv_triage_1', c.input, { temperature: 1, seed: sampleSeed(29, s) })))))
    expect(outs.size).toBeGreaterThan(1)
  })
})

describe('output quality depends on the prompt version', () => {
  it('v2 (categories + tie rule) beats v1 overall', () => {
    expect(correct('pv_triage_2')).toBeGreaterThan(correct('pv_triage_1') + 0.1)
  })

  it('v3 (few-shot) wins on some cases and loses on others', () => {
    const account = TRIAGE_V2.filter((c) => c.reference === 'account')
    const others = TRIAGE_V2.filter((c) => c.reference !== 'account' && !c.tags.includes('long-context'))
    expect(correct('pv_triage_3', account, 10)).toBeLessThan(correct('pv_triage_2', account, 10))
    expect(correct('pv_triage_3', others, 10)).toBeGreaterThanOrEqual(correct('pv_triage_2', others, 10))
  })

  it('format follows the instructions: bare label vs prose', () => {
    const c = TRIAGE_V2[0]
    expect(text(planGeneration(req('pv_triage_2', c.input, { temperature: 0 })))).toMatch(/^[a-z]+$/)
    expect(text(planGeneration(req('pv_triage_1', c.input, { temperature: 0 })))).toMatch(/^Category: /)
  })

  it('JSON prompts: v1 wraps in fences, v2 returns bare JSON', () => {
    const email = { email: 'Hi team, please send 3 ceramic mugs to Berlin.' }
    expect(text(planGeneration(req('pv_orders_1', email, { temperature: 0 })))).toContain('```json')
    expect(() => JSON.parse(text(planGeneration(req('pv_orders_2', email, { temperature: 0 }))))).not.toThrow()
  })
})

describe('limits', () => {
  it('a prompt beyond the context window is a permanent error', () => {
    const long = TRIAGE_V2.find((c) => c.tags.includes('long-context'))!
    const small = planGeneration(req('pv_triage_2', long.input))
    expect(small.ok).toBe(false)
    if (!small.ok) expect(small.errorType).toBe('context_length_exceeded')
    expect(planGeneration(req('pv_triage_2', long.input, { model: 'mock-large' })).ok).toBe(true)
  })

  it('max tokens truncates with finishReason length', () => {
    const r = planGeneration(req('pv_status_1', { code: '404' }, { maxTokens: 5 }))
    expect(r.ok && r.finishReason).toBe('length')
    expect(r.ok && r.outputTokens).toBe(5)
  })

  it('unknown models are invalid requests', () => {
    const r = planGeneration(req('pv_triage_2', TRIAGE_V2[0].input, { model: 'gpt-x' }))
    expect(r.ok).toBe(false)
  })
})
