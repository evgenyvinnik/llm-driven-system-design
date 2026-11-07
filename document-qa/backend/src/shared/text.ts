/**
 * Word-level text helpers shared by the mock embedder (features), the mock
 * model (extractive answers) and the full-text arm of retrieval. A tiny
 * stemmer plus a handful of concept groups (refund / reimburse / expense) give
 * the mock embedding the one property retrieval depends on: related text
 * lands closer than unrelated text, even without shared words.
 * @module shared/text
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does doing for from had has have having he her his how i if in into is it its ' +
    'me my of on or our ours she so than that the their them then there these they this those to too up us was we were what when where ' +
    'which who whom why will with would you your yours about after before also just please any all each per via may must should shall ' +
    'not no yes more most much many some such only own same other than very can will tell know need want get got does'
  ).split(' '),
)

/** Concept groups: words that should embed near each other. */
const CONCEPTS: string[][] = [
  ['refund', 'reimburse', 'reimbursement', 'expense', 'expenses', 'receipt', 'receipts', 'claim', 'claims'],
  ['vacation', 'pto', 'leave', 'holiday', 'holidays', 'time-off', 'timeoff'],
  ['remote', 'home', 'wfh', 'hybrid', 'telework'],
  ['laptop', 'computer', 'device', 'hardware', 'equipment', 'macbook'],
  ['password', 'credential', 'credentials', 'mfa', 'authentication', 'login', '2fa'],
  ['incident', 'outage', 'pager', 'oncall', 'on-call', 'escalation', 'sev'],
  ['backup', 'backups', 'snapshot', 'snapshots', 'restore'],
  ['travel', 'flight', 'flights', 'hotel', 'trip', 'airfare', 'mileage'],
  ['salary', 'compensation', 'pay', 'payroll', 'bonus', 'raise'],
  ['deploy', 'deployment', 'release', 'rollout', 'ship', 'launch'],
  ['customer', 'customers', 'client', 'clients', 'account', 'accounts'],
  ['price', 'pricing', 'cost', 'costs', 'budget', 'spend', 'fee', 'fees'],
  ['security', 'secure', 'encryption', 'encrypt', 'vulnerability', 'patch'],
  ['onboarding', 'onboard', 'orientation', 'welcome', 'first-week'],
]

const conceptOf = new Map<string, string>()
CONCEPTS.forEach((group, i) => group.forEach((w) => conceptOf.set(w, `concept${i}`)))

export function stem(word: string): string {
  if (word.length > 6 && word.endsWith('ments')) return word.slice(0, -5)
  if (word.length > 5 && word.endsWith('ment')) return word.slice(0, -4)
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** Lower-cased content words (stopwords and one-letter tokens removed). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/** A word's concept id when it belongs to a group, else its stem. */
export function term(word: string): string {
  return conceptOf.get(word) ?? conceptOf.get(stem(word)) ?? stem(word)
}

export function terms(text: string): string[] {
  return words(text).map(term)
}

/** Lower-case, collapse whitespace, drop trailing punctuation: the answer-cache key form of a question. */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?.!\s]+$/, '')
}

/** Rough token estimate (≈ 4 characters per token), used for chunk sizing and usage when no tokenizer is at hand. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export interface Sentence {
  text: string
  start: number
  end: number
}

/**
 * Splits text into sentences with exact offsets (text.slice(start, end) ===
 * sentence.text). A sentence ends at . ! or ? followed by whitespace or the
 * end, or at a newline, so "3.5 days" stays in one sentence.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = []
  let start = 0
  const push = (end: number) => {
    const raw = text.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed.length > 0) out.push({ text: trimmed, start: start + lead, end: start + lead + trimmed.length })
    start = end
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') push(i + 1)
    else if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 === text.length || /\s/.test(text[i + 1]))) push(i + 1)
  }
  push(text.length)
  return out
}
