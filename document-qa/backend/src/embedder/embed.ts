/**
 * Deterministic mock embedding: hashed bag of terms into 256 signed
 * dimensions, L2-normalized.
 *
 * Features per text: each term (concept id or stem, weight 1.0), each adjacent
 * term pair (0.5) and the character trigrams of each stem (0.25). Concept
 * groups make "reimbursement" land near "expense claims"; trigrams make
 * "backup" land near "backups". So related text really is closer, and cosine
 * similarity ranks chunks meaningfully, which is the only property the
 * retrieval pipeline depends on. Same input → same vector, on every machine.
 * @module embedder/embed
 */
import { stem, terms, words } from '../shared/text.js'

export const EMBEDDING_DIMS = 256
export const EMBEDDING_MODEL = 'mock-embed-256'

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function add(vector: Float64Array, feature: string, weight: number): void {
  const h = fnv1a(feature)
  vector[h % EMBEDDING_DIMS] += h & 0x8000 ? weight : -weight
}

export function embed(text: string): number[] {
  const v = new Float64Array(EMBEDDING_DIMS)
  const ts = terms(text)
  for (const t of ts) add(v, `t:${t}`, 1)
  for (let i = 0; i + 1 < ts.length; i++) add(v, `b:${ts[i]}|${ts[i + 1]}`, 0.5)
  for (const w of words(text)) {
    const s = `^${stem(w)}$`
    for (let i = 0; i + 3 <= s.length; i++) add(v, `g:${s.slice(i, i + 3)}`, 0.25)
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  const out = new Array<number>(EMBEDDING_DIMS)
  for (let i = 0; i < EMBEDDING_DIMS; i++) out[i] = norm === 0 ? 0 : Math.round((v[i] / norm) * 1e6) / 1e6
  return out
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}
