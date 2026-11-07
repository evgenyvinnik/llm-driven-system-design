/**
 * Order extraction to JSON. The oracle parses quantity, product, city and
 * priority from the order email. Number words ("a dozen", "a pair of") are the
 * hard part unless the prompt says to convert them to digits. Unless the
 * prompt asks for "only the JSON", the model wraps the object in a sentence
 * and ```json fences, which a strict JSON-shape scorer can't parse. That is the
 * re-scoring demo: fix the scorer, keep the outputs.
 * @module model/skills/extract
 */
import type { SkillContext, SkillOutput } from './types.js'

const NUMBER_WORDS: [RegExp, number][] = [
  [/^half a dozen$/, 6],
  [/^a dozen$/, 12],
  [/^a pair of$/, 2],
  [/^(a|an|one)$/, 1],
  [/^two$/, 2],
  [/^three$/, 3],
  [/^four$/, 4],
  [/^five$/, 5],
  [/^six$/, 6],
  [/^seven$/, 7],
  [/^eight$/, 8],
  [/^nine$/, 9],
  [/^ten$/, 10],
  [/^twelve$/, 12],
]
const QTY = '(\\d+|half a dozen|a dozen|a pair of|an|a|one|two|three|four|five|six|seven|eight|nine|ten|twelve)'
const COLORS = new Set(['red', 'blue', 'green', 'black', 'white', 'grey', 'gray', 'yellow', 'oak', 'walnut'])

export interface OrderFields {
  product: string
  quantity: number
  city: string
  priority: 'high' | 'normal'
}

function singular(word: string): string {
  if (/(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2)
  if (/[^s]s$/.test(word)) return word.slice(0, -1)
  return word
}

export function parseQuantity(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  const hit = NUMBER_WORDS.find(([re]) => re.test(raw.toLowerCase()))
  return hit ? hit[1] : 1
}

/** Ground truth for an order email; the dataset references are authored against this. */
export function oracleOrder(email: string): OrderFields & { quantityWord: boolean } {
  const m = new RegExp(`\\b${QTY}\\s+((?:[a-z-]+\\s+){0,2}?[a-z-]+)\\s+(?:to|delivered|shipped|sent|for)\\b`, 'i').exec(email)
  const rawQty = m?.[1] ?? '1'
  const words = (m?.[2] ?? 'item').toLowerCase().split(/\s+/)
  const product = words.filter((w) => !COLORS.has(w)).map((w, i, arr) => (i === arr.length - 1 ? singular(w) : w)).join(' ')
  const cities = [...email.matchAll(/\b(?:to|in)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g)].map((x) => x[1])
  const city = cities[cities.length - 1] ?? 'unknown'
  const priority = /\b(urgent|urgently|asap|rush|as soon as possible|today)\b/i.test(email) ? 'high' : 'normal'
  return { product, quantity: parseQuantity(rawQty), city, priority, quantityWord: !/^\d+$/.test(rawQty) }
}

function extractEmail(prompt: string): string {
  const idx = prompt.toLowerCase().lastIndexOf('email:')
  return (idx >= 0 ? prompt.slice(idx + 'email:'.length) : prompt).split(/\n\s*\n/)[0].trim()
}

export function extractSkill(ctx: SkillContext): SkillOutput {
  const email = extractEmail(ctx.prompt)
  const truth = oracleOrder(email)
  const text = ctx.text
  const numberRule = /number words|as digits|convert .*digits/.test(text)
  const priorityRule = /priority (?:is )?"?high"? (?:when|if)|urgent.*high/.test(text)
  const base = ctx.spec.baseError

  const out: OrderFields = { ...truth }
  const pQty = base + (truth.quantityWord && truth.quantity !== 1 ? (numberRule ? 0.05 : 0.5) : 0)
  if (ctx.draw('quantity') < pQty) out.quantity = truth.quantityWord ? 1 : truth.quantity + 1
  const pProduct = base + (truth.product.includes(' ') ? 0.1 : 0)
  if (ctx.draw('product') < pProduct) out.product = truth.product.split(' ').slice(-1)[0]
  if (ctx.draw('city') < base) out.city = truth.city.toLowerCase() === truth.city ? 'unknown' : `${truth.city} office`
  const pPriority = base + (/\btoday\b/i.test(email) && !priorityRule ? 0.4 : 0)
  if (ctx.draw('priority') < pPriority) out.priority = truth.priority === 'high' ? 'normal' : 'high'

  const json = JSON.stringify({ product: out.product, quantity: out.quantity, city: out.city, priority: out.priority }, null, 2)
  const bare = /only (?:the |raw )?json|no markdown|without (?:code )?fences/.test(text)
  return {
    text: bare ? json : `Here is the extracted order:\n\n\`\`\`json\n${json}\n\`\`\``,
    detail: { skill: 'extract', truth, out },
  }
}
