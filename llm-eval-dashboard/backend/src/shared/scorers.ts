/**
 * Scorer kinds, their version configs, and the deterministic scoring
 * functions. Pure: a score depends only on (scorer version config, output,
 * reference), which is what makes re-scoring stored outputs meaningful.
 *
 * model_graded calls the mock judge (worker/score.ts); human scores come from
 * annotations. Both share the score shape: a number in [0, 1] plus pass/fail.
 * @module shared/scorers
 */
import { z } from 'zod'

export const SCORER_KINDS = ['exact_match', 'regex', 'contains', 'json_shape', 'model_graded', 'human'] as const
export type ScorerKind = (typeof SCORER_KINDS)[number]

export const scorerConfigSchemas = {
  exact_match: z.object({ caseSensitive: z.boolean().default(true), trim: z.boolean().default(true) }).strict(),
  regex: z
    .object({
      /** `{{reference}}` is replaced by the case's reference, regex-escaped. */
      pattern: z.string().min(1).max(500),
      flags: z.string().regex(/^[imsu]*$/).default(''),
    })
    .strict(),
  contains: z.object({ caseSensitive: z.boolean().default(false) }).strict(),
  json_shape: z
    .object({
      requiredKeys: z.array(z.string().min(1).max(64)).min(1).max(20),
      /** Compare each key's value with the reference JSON (case-insensitive for strings). */
      compareValues: z.boolean().default(true),
      /** Accept ```json fences and a sentence before the object. */
      stripFences: z.boolean().default(false),
    })
    .strict(),
  model_graded: z
    .object({
      rubric: z.string().min(1).max(2000),
      strictness: z.enum(['lenient', 'strict']).default('lenient'),
      /** Grade (1-5) at or above which the judge's verdict is a pass. */
      passGrade: z.number().int().min(1).max(5).default(4),
    })
    .strict(),
  human: z.object({ instructions: z.string().max(2000).default('') }).strict(),
} satisfies Record<ScorerKind, z.ZodTypeAny>

export type ScorerConfig<K extends ScorerKind> = z.infer<(typeof scorerConfigSchemas)[K]>

export interface ScoreResult {
  score: number
  passed: boolean
  rationale: string
  confidence?: number
}

/** Validates and normalises a config for `kind`; throws ZodError or Error (bad regex). */
export function parseScorerConfig(kind: ScorerKind, raw: unknown): Record<string, unknown> {
  const parsed = scorerConfigSchemas[kind].parse(raw ?? {}) as Record<string, unknown>
  if (kind === 'regex') compileRegex(parsed as ScorerConfig<'regex'>, 'x')
  return parsed
}

export function isDeterministic(kind: ScorerKind): boolean {
  return kind === 'exact_match' || kind === 'regex' || kind === 'contains' || kind === 'json_shape'
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function compileRegex(config: ScorerConfig<'regex'>, reference: string): RegExp {
  const source = config.pattern.replace(/\{\{\s*reference\s*\}\}/g, escapeRegex(reference.trim()))
  return new RegExp(source, config.flags)
}

const pass = (rationale: string): ScoreResult => ({ score: 1, passed: true, rationale })
const fail = (rationale: string): ScoreResult => ({ score: 0, passed: false, rationale })
const preview = (s: string, n = 40) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s)

export function scoreDeterministic(kind: ScorerKind, config: Record<string, unknown>, output: string, reference: string): ScoreResult {
  switch (kind) {
    case 'exact_match': {
      const c = scorerConfigSchemas.exact_match.parse(config)
      let o = c.trim ? output.trim() : output
      let r = c.trim ? reference.trim() : reference
      if (!c.caseSensitive) {
        o = o.toLowerCase()
        r = r.toLowerCase()
      }
      return o === r ? pass('exact match') : fail(`${preview(o)} ≠ ${preview(r)}`)
    }
    case 'regex': {
      const c = scorerConfigSchemas.regex.parse(config)
      const re = compileRegex(c, reference)
      return re.test(output) ? pass(`matches /${re.source}/${re.flags}`) : fail(`no match for /${re.source}/${re.flags}`)
    }
    case 'contains': {
      const c = scorerConfigSchemas.contains.parse(config)
      const o = c.caseSensitive ? output : output.toLowerCase()
      const r = c.caseSensitive ? reference.trim() : reference.trim().toLowerCase()
      return o.includes(r) ? pass(`contains ${preview(r)}`) : fail(`does not contain ${preview(r)}`)
    }
    case 'json_shape':
      return scoreJsonShape(scorerConfigSchemas.json_shape.parse(config), output, reference)
    default:
      throw new Error(`${kind} is not a deterministic scorer`)
  }
}

/** Pulls a JSON object out of ```json fences or surrounding prose. */
export function extractJsonCandidate(output: string): string {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  return start >= 0 && end > start ? output.slice(start, end + 1) : output.trim()
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase()
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  return JSON.stringify(a) === JSON.stringify(b)
}

function scoreJsonShape(c: ScorerConfig<'json_shape'>, output: string, reference: string): ScoreResult {
  const text = c.stripFences ? extractJsonCandidate(output) : output.trim()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail(`not valid JSON${c.stripFences ? '' : ' (fences and prose are not stripped by this version)'}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('JSON is not an object')
  let expected: Record<string, unknown> = {}
  if (c.compareValues) {
    try {
      expected = JSON.parse(reference) as Record<string, unknown>
    } catch {
      return fail('reference is not valid JSON')
    }
  }
  const obj = value as Record<string, unknown>
  const wrong: string[] = []
  for (const key of c.requiredKeys) {
    if (!(key in obj)) wrong.push(`${key} missing`)
    else if (c.compareValues && key in expected && !sameValue(obj[key], expected[key])) wrong.push(`${key}=${JSON.stringify(obj[key])}`)
  }
  const matched = c.requiredKeys.length - wrong.length
  const score = matched / c.requiredKeys.length
  return { score, passed: wrong.length === 0, rationale: wrong.length === 0 ? `all ${c.requiredKeys.length} fields match` : `${matched}/${c.requiredKeys.length} fields; ${wrong.join(', ')}` }
}
