/**
 * Support-ticket classification. The mock "knows" the right answer through a
 * keyword oracle with a priority rule for ties (billing > account > shipping >
 * technical), and slips with a probability that depends on the prompt:
 *
 * - listing the categories helps; a tie-break rule helps a lot on tickets that
 *   mention two categories (the "hard" cases);
 * - few-shot examples help a little, but bias the model toward the example
 *   labels: a category with no example gets mislabeled more often. So a
 *   "better" prompt really wins on some cases and loses on others;
 * - "respond with only the category" yields a bare label; otherwise the model
 *   answers in prose, which an exact-match scorer fails and `contains` passes.
 * @module model/skills/classify
 */
import type { SkillContext, SkillOutput } from './types.js'

export const CATEGORIES = ['billing', 'account', 'shipping', 'technical', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

const KEYWORDS: Record<Exclude<Category, 'other'>, string[]> = {
  billing: ['charge', 'charged', 'refund', 'invoice', 'payment', 'billed', 'subscription', 'card', 'price', 'overcharged', 'receipt'],
  account: ['password', 'username', 'email address', '2fa', 'two-factor', 'locked out', 'delete my account', 'profile', 'sign in', 'log in'],
  shipping: ['delivery', 'package', 'shipped', 'shipping', 'tracking', 'courier', 'parcel', 'delivered'],
  technical: ['crash', 'crashes', 'crashed', 'error', 'bug', 'slow', 'freezes', 'blank screen', 'sync', 'timeout', 'api'],
}
const PRIORITY: Exclude<Category, 'other'>[] = ['billing', 'account', 'shipping', 'technical']
const CONFUSION: Record<Category, Category> = { billing: 'account', account: 'technical', shipping: 'other', technical: 'account', other: 'technical' }

export interface Oracle {
  label: Category
  hits: Record<string, number>
  /** Categories with hits, in order of first mention in the ticket. */
  mentioned: Category[]
  ambiguous: number
}

/** The ground truth the datasets are authored against. */
export function oracleCategory(ticket: string): Oracle {
  const text = ticket.toLowerCase()
  const hits: Record<string, number> = {}
  const firstAt: Record<string, number> = {}
  for (const cat of PRIORITY) {
    for (const kw of KEYWORDS[cat]) {
      const m = new RegExp(`\\b${kw.replace(/[-]/g, '\\-')}\\b`).exec(text)
      if (m) {
        hits[cat] = (hits[cat] ?? 0) + 1
        firstAt[cat] = Math.min(firstAt[cat] ?? Infinity, m.index)
      }
    }
  }
  const mentioned = (Object.keys(hits) as Category[]).sort((a, b) => firstAt[a] - firstAt[b])
  if (mentioned.length === 0) return { label: 'other', hits, mentioned, ambiguous: 0 }
  const best = [...PRIORITY].filter((c) => hits[c]).sort((a, b) => hits[b] - hits[a] || PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0]
  return { label: best, hits, mentioned, ambiguous: mentioned.length - 1 }
}

function extractTicket(prompt: string): string {
  const idx = prompt.toLowerCase().lastIndexOf('ticket:')
  const rest = idx >= 0 ? prompt.slice(idx + 'ticket:'.length) : prompt
  return rest.split(/\n\s*\n/)[0].trim()
}

function parseExamples(prompt: string): Category[] {
  const labels: Category[] = []
  for (const m of prompt.matchAll(/^\s*example:.*->\s*([a-z]+)\s*$/gim)) {
    const label = m[1].toLowerCase() as Category
    if ((CATEGORIES as readonly string[]).includes(label)) labels.push(label)
  }
  return labels
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function classifySkill(ctx: SkillContext): SkillOutput {
  const ticket = extractTicket(ctx.prompt)
  const oracle = oracleCategory(ticket)
  const text = ctx.text
  const listed = text.includes('categories:')
  const tieRule = /if (?:a|the) ticket mentions|tie-?break|priority order/.test(text)
  const examples = parseExamples(ctx.prompt)
  const fewShot = examples.length > 0

  let p = ctx.spec.baseError
  if (!listed) p += 0.1
  p += oracle.ambiguous * (tieRule ? 0.06 : 0.38)
  let biasLabel: Category | null = null
  if (fewShot) {
    p -= 0.04
    if (!examples.includes(oracle.label)) {
      p += 0.32
      const counts = new Map<Category, number>()
      for (const e of examples) counts.set(e, (counts.get(e) ?? 0) + 1)
      biasLabel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    }
  }
  p = Math.min(0.97, Math.max(0.01, p))

  const correct = ctx.draw('classify') >= p
  let label: Category = oracle.label
  if (!correct) {
    const otherMention = oracle.mentioned.find((c) => c !== oracle.label)
    label = otherMention ?? (biasLabel && biasLabel !== oracle.label ? biasLabel : CONFUSION[oracle.label])
  }

  const bare = /respond with only|only the (?:category|label)|answer with (?:just|only)/.test(text)
  if (bare) return { text: listed || text.includes('lowercase') ? label : cap(label), detail: { skill: 'classify', truth: oracle.label, label, p } }
  const reason =
    label === 'other'
      ? "the ticket doesn't match billing, account, shipping or technical issues"
      : `the customer mentions ${Object.keys(oracle.hits).length > 0 ? 'details that point to' : 'something about'} ${label}`
  return { text: `Category: ${cap(label)}\nReason: ${cap(reason)}.`, detail: { skill: 'classify', truth: oracle.label, label, p } }
}
