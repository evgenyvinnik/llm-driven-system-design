/**
 * Deterministic generation for the mock model. Pure: the same request always
 * plans the same tokens, which is what lets the seed materialize runs with the
 * code path a live worker uses, and lets tests pin outputs.
 *
 * Determinism contract: output depends on (model, system, prompt,
 * temperature, seed). A worker sends seed = sampleSeed(config.seed, sample),
 * and the prompt is the prompt version rendered with the case, so the output
 * is a function of (prompt version, case, sample index, seed). At temperature
 * 0 the seed is ignored and every sample is identical; as temperature rises,
 * per-sample randomness gets a larger share of every decision.
 * @module model/generator
 */
import { createHash } from 'node:crypto'
import { mulberry32 } from '../shared/stats.js'
import { estimateTokens, MODELS, tokenize, type ModelSpec } from './catalog.js'
import { classifySkill } from './skills/classify.js'
import { explainSkill } from './skills/explain.js'
import { extractSkill } from './skills/extract.js'
import type { SkillContext, SkillOutput } from './skills/types.js'

export interface GenerateRequest {
  model: string
  system: string
  prompt: string
  temperature: number
  maxTokens: number
  seed: number
}

export type GenerationPlan =
  | {
      ok: true
      text: string
      tokens: string[]
      finishReason: 'stop' | 'length'
      inputTokens: number
      outputTokens: number
      skill: string
      detail: Record<string, unknown>
    }
  | { ok: false; errorType: 'context_length_exceeded' | 'invalid_request'; message: string; inputTokens: number }

export function seedFrom(material: string): number {
  return createHash('sha256').update(material).digest().readUInt32LE(0)
}

function makeDraw(req: GenerateRequest): (label: string) => number {
  const t = Math.min(1, Math.max(0, req.temperature))
  const base = `${req.model}\u0000${req.system}\u0000${req.prompt}`
  return (label: string) => {
    const caseU = mulberry32(seedFrom(`${base}\u0000${label}`))()
    if (t === 0) return caseU
    const sampleU = mulberry32(seedFrom(`${base}\u0000${req.seed}\u0000${label}`))()
    return (1 - t) * caseU + t * sampleU
  }
}

function fallbackSkill(ctx: SkillContext): SkillOutput {
  const words = (ctx.prompt.toLowerCase().match(/[a-z]{4,}/g) ?? ['request']).slice(0, 6)
  const pick = (label: string) => words[Math.floor(ctx.draw(label) * words.length)]
  const text = `Here is a short answer about ${pick('a')}. The key point is ${pick('b')}, and it depends on ${pick('c')}. Check ${pick('d')} before acting.`
  return { text, detail: { skill: 'fallback' } }
}

function chooseSkill(text: string): (ctx: SkillContext) => SkillOutput {
  if (text.includes('ticket') && /classif|categor/.test(text)) return classifySkill
  if (text.includes('json') && text.includes('order')) return extractSkill
  if (text.includes('http') && text.includes('status')) return explainSkill
  return fallbackSkill
}

export function planGeneration(req: GenerateRequest): GenerationPlan {
  const spec: ModelSpec | undefined = MODELS[req.model]
  const inputTokens = estimateTokens(`${req.system}\n${req.prompt}`)
  if (!spec) return { ok: false, errorType: 'invalid_request', message: `Unknown model ${req.model}`, inputTokens }
  if (inputTokens > spec.contextTokens) {
    return {
      ok: false,
      errorType: 'context_length_exceeded',
      message: `Prompt is ${inputTokens} tokens; ${spec.id} accepts at most ${spec.contextTokens}`,
      inputTokens,
    }
  }
  const text = `${req.system}\n${req.prompt}`.toLowerCase()
  const ctx: SkillContext = { prompt: req.prompt, system: req.system, text, spec, draw: makeDraw(req) }
  const skill = chooseSkill(text)
  const out = skill(ctx)
  let tokens = tokenize(out.text)
  let finishReason: 'stop' | 'length' = 'stop'
  if (tokens.length > req.maxTokens) {
    tokens = tokens.slice(0, req.maxTokens)
    finishReason = 'length'
  }
  return {
    ok: true,
    text: tokens.join(''),
    tokens,
    finishReason,
    inputTokens,
    outputTokens: tokens.length,
    skill: String(out.detail.skill ?? 'fallback'),
    detail: out.detail,
  }
}
