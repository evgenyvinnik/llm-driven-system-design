/**
 * Mock embedding model: deterministic 256-dimension vectors from hashed
 * "concepts". Words in the same concept group (cancel / change / reschedule;
 * flight / travel / itinerary) hash to the same features, so a query like
 * "cancel my flight" lands near "change of travel plans" even though they
 * share no words. That is the one property of real embeddings the retrieval
 * pipeline depends on, and it lets hybrid search show why vector and keyword
 * search each catch what the other misses. It is not semantic in any deeper
 * sense, and the docs say so.
 * @module retrieval/embed
 */

export const EMBEDDING_DIMS = 256

const CONCEPTS: string[][] = [
  ['cancel', 'change', 'reschedule', 'postpone', 'move', 'push', 'delay', 'shift'],
  ['flight', 'travel', 'trip', 'itinerary', 'plane', 'airline', 'booking', 'fly', 'lisbon', 'sfo', 'lis'],
  ['budget', 'spend', 'cost', 'forecast', 'money', 'expense', 'numbers', 'figure', 'dollar', 'price', 'allocation'],
  ['meeting', 'sync', 'call', 'standup', 'catchup', 'session', 'review'],
  ['hire', 'hiring', 'headcount', 'recruit', 'recruiting', 'role', 'candidate', 'req', 'interview'],
  ['contract', 'renewal', 'agreement', 'renew', 'subscription', 'license', 'vendor'],
  ['offsite', 'retreat', 'onsite', 'summit', 'venue'],
  ['invoice', 'bill', 'billing', 'payment', 'overdue', 'due', 'remittance', 'pay'],
  ['launch', 'release', 'ship', 'rollout', 'ga', 'beta'],
  ['bug', 'issue', 'incident', 'outage', 'error', 'failure', 'retro', 'postmortem'],
  ['summary', 'recap', 'overview', 'tldr', 'notes'],
  ['salary', 'compensation', 'comp', 'band', 'bands', 'equity'],
  ['onboarding', 'onboard', 'setup', 'welcome', 'orientation'],
  ['agenda', 'schedule', 'plan', 'timeline', 'roadmap'],
]

const STOPWORDS = new Set(
  'a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its me my of on or our she so than that the their them then there these they this to up us was we were what when where which who why will with would you your about after before also just please thanks hi hello dear best regards'.split(
    ' ',
  ),
)

const conceptOf = new Map<string, string>()
CONCEPTS.forEach((group, i) => group.forEach((word) => conceptOf.set(word, `c${i}`)))

export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
}

/** Maps a word to its concept ID, or to its stem when it belongs to no concept. */
export function concept(word: string): string {
  return conceptOf.get(word) ?? conceptOf.get(stem(word)) ?? stem(word)
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = fnv1a(feature)
  vector[hash % EMBEDDING_DIMS] += hash & 0x100 ? weight : -weight
}

export function embed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0)
  const concepts = tokenize(text).map(concept)
  for (const c of concepts) addFeature(vector, c, 1)
  for (let i = 0; i + 1 < concepts.length; i++) addFeature(vector, `${concepts[i]}|${concepts[i + 1]}`, 0.5)
  const norm = Math.hypot(...vector)
  if (norm === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((v) => v / norm)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => v.toFixed(6)).join(',')}]`
}
