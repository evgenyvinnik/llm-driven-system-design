/**
 * Deterministic text generation for the mock model.
 *
 * Output is built from keywords in the prompt and a phrase bank, so it reads
 * like a plausible answer and changes when the prompt changes. With
 * temperature 0 (or an explicit seed) the same request always produces the
 * same tokens; otherwise a per-request nonce varies the output, like sampling.
 */
import { createHash } from 'node:crypto'
import type { ModelSpec } from '../shared/catalog.js'

export interface GenerateRequest {
  model: string
  system: string
  input: string
  temperature: number
  topP: number
  maxTokens: number
  seed?: number
}

export interface GenerationPlan {
  tokens: string[]
  finishReason: 'stop' | 'length'
  /** Index of the token after which the simulated failure happens, or null. */
  failAfterToken: number | null
}

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have how i if in into is it its of on or our so that the
  their them then there these this those to was we what when where which who why will with you your
  please write give make explain describe using use about can should would could me my any all each
  more most some such than too very just also only own same other into over under again further once`
    .split(/\s+/)
    .filter(Boolean),
)

const OPENINGS = [
  'Here is a response focused on {k}.',
  'Based on what you described about {k}, here is what stands out.',
  'Short answer: {k} is the part that matters most here.',
  'Looking at {k} first gives the clearest path forward.',
]

const SENTENCES = [
  'The most important detail is {k}, which shapes everything else.',
  'Start by clarifying how {k} affects the outcome you want.',
  'Treat {k} as the primary signal and {k2} as supporting context.',
  'If {k} changes, revisit the assumptions behind this answer.',
  'Keep the wording about {k} specific so a reviewer can verify it quickly.',
  'Consider whether {k} needs a follow-up question before acting.',
  'A common mistake is to handle {k2} before {k} is settled.',
  'Writing down how {k} and {k2} interact makes the trade-off explicit.',
  'For {k}, a small concrete example usually beats a general rule.',
  'The risk with {k2} is that it hides problems in {k} until late.',
  'Tone matters: keep the message about {k} calm and direct.',
  'Measure {k} before and after, so the change is easy to judge.',
]

const BULLETS = [
  'Confirm the scope of {k} with the person asking.',
  'List the constraints that apply to {k2}.',
  'Draft the smallest change that addresses {k}.',
  'Check the result against one real example of {k2}.',
  'Note open questions about {k} for follow-up.',
  'Record the decision and why {k} drove it.',
]

const CLOSINGS = [
  'Let me know if you want a shorter version.',
  'I can expand any of these points if useful.',
  'Happy to adjust the tone or level of detail.',
]

/** Builds the full token sequence for a request. Pure: depends only on its arguments. */
export function planGeneration(req: GenerateRequest, spec: ModelSpec, nonce: string, failureRate: number): GenerationPlan {
  const deterministic = req.temperature === 0 || req.seed !== undefined
  const seedMaterial = [
    req.model,
    req.system,
    req.input,
    req.temperature,
    req.topP,
    deterministic ? String(req.seed ?? 0) : nonce,
  ].join('\u0000')
  const rand = mulberry32(seedFrom(seedMaterial))
  const keywords = extractKeywords(`${req.input} ${req.system}`)
  const text = spec.style === 'structured' ? structured(rand, keywords) : concise(rand, keywords)

  let tokens = tokenize(text)
  let finishReason: GenerationPlan['finishReason'] = 'stop'
  if (tokens.length > req.maxTokens) {
    tokens = tokens.slice(0, req.maxTokens)
    finishReason = 'length'
  }

  // Failure is decided with a separate random stream so it doesn't change the text.
  const failRand = mulberry32(seedFrom(`${nonce}:fail`))
  const failAfterToken =
    failureRate > 0 && failRand() < failureRate && tokens.length > 4
      ? Math.max(2, Math.floor(tokens.length * (0.2 + failRand() * 0.5)))
      : null

  return { tokens, finishReason, failAfterToken }
}

function concise(rand: () => number, kw: string[]): string {
  const sentenceCount = 4 + Math.floor(rand() * 4)
  const parts = [fill(pick(rand, OPENINGS), rand, kw)]
  for (let i = 0; i < sentenceCount; i++) parts.push(fill(pick(rand, SENTENCES), rand, kw))
  const body = parts.join(' ')
  return `${body}\n\n${pick(rand, CLOSINGS)}`
}

function structured(rand: () => number, kw: string[]): string {
  const summary = [pick(rand, OPENINGS), pick(rand, SENTENCES), pick(rand, SENTENCES)]
    .map((s) => fill(s, rand, kw))
    .join(' ')
  const bullets = shuffle(rand, BULLETS)
    .slice(0, 3 + Math.floor(rand() * 3))
    .map((s) => `- ${fill(s, rand, kw)}`)
    .join('\n')
  const steps = shuffle(rand, SENTENCES)
    .slice(0, 3)
    .map((s, i) => `${i + 1}. ${fill(s, rand, kw)}`)
    .join('\n')
  const detail = Array.from({ length: 3 + Math.floor(rand() * 3) }, () => fill(pick(rand, SENTENCES), rand, kw)).join(' ')
  return `## Summary\n${summary}\n\n## Key points\n${bullets}\n\n## Details\n${detail}\n\n## Next steps\n${steps}\n\n${pick(rand, CLOSINGS)}`
}

export function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>()
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (STOPWORDS.has(raw)) continue
    counts.set(raw, (counts.get(raw) ?? 0) + 1)
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .map(([word]) => word)
  return ranked.length > 0 ? ranked.slice(0, 8) : ['the request', 'the context']
}

function fill(template: string, rand: () => number, kw: string[]): string {
  const k = pick(rand, kw)
  const others = kw.filter((w) => w !== k)
  const k2 = others.length > 0 ? pick(rand, others) : 'the surrounding context'
  return template
    .replace('{K}', k.charAt(0).toUpperCase() + k.slice(1))
    .replace('{k}', k)
    .replace('{k2}', k2)
}

/** Splits text into word-sized tokens that keep their trailing whitespace, so joining them restores the text. */
export function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]
}

function shuffle<T>(rand: () => number, items: readonly T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function seedFrom(material: string): number {
  return createHash('sha256').update(material).digest().readUInt32LE(0)
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
