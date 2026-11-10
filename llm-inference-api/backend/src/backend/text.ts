/**
 * Deterministic output text for the mock model. The same seed always yields the
 * same tokens, so tests and the load generator can predict lengths, and the
 * console shows readable text instead of random characters.
 * @module backend/text
 */
import { fnv1a } from '../shared/tokens.js'

const SENTENCES = [
  'Admission control charges the estimated cost before any work is queued.',
  'The request id is assigned at the edge and owns the work from then on.',
  'A batch leaves when it is full, when its oldest request has waited long enough, or when a deadline is close.',
  'Prefix caching turns a repeated system prompt into a cheap lookup instead of a full prefill.',
  'Consistent hashing keeps most assignments stable when a backend joins or leaves.',
  'Bounded load stops one hot prefix from overwhelming a single replica.',
  'Once the first token has been sent, the request cannot move to another backend.',
  'Queue time and generation time are recorded separately, so a slow queue is never blamed on the model.',
  'Deficit round robin gives every tenant a turn in proportion to its weight.',
  'Draining lets in-flight streams finish while new work goes elsewhere.',
  'A cancellation and a completion race through one conditional update, and exactly one wins.',
  'Unused reserved tokens are refunded when the request finishes.',
  'Overload sheds new work at the edge instead of letting queues grow without bound.',
  'Continuous batching admits new sequences at every decode step.',
  'Static batches wait for their longest member, which wastes slots on short requests.',
  'The interactive lane never waits behind bulk work, and bulk work still gets a guaranteed share.',
  'Retry-After tells a tenant exactly when its bucket will hold enough tokens again.',
  'A backend that refuses work is a routing hint, not an error the caller sees.',
  'Model versions roll one replica at a time, so capacity never drops to zero.',
  'Usage is written once per request, and the refund happens only when that write succeeds.',
]

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

/** Natural output length for a seed (before max_tokens truncation). */
export function naturalLength(seed: string): number {
  return 24 + (fnv1a(`len:${seed}`) % 120)
}

/** Token generator: word-sized pieces with their leading space. */
export function tokenStream(seed: string): () => string {
  const rand = mulberry32(fnv1a(seed))
  let words: string[] = []
  let first = true
  return () => {
    if (words.length === 0) words = SENTENCES[Math.floor(rand() * SENTENCES.length)].split(' ')
    const word = words.shift() as string
    const piece = first ? word : ` ${word}`
    first = false
    return piece
  }
}

/** The full deterministic output for a seed and length (used by tests). */
export function fullText(seed: string, tokens: number): string {
  const next = tokenStream(seed)
  let out = ''
  for (let i = 0; i < tokens; i++) out += next()
  return out
}
