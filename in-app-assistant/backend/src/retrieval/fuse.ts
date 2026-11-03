/**
 * Fuse and rerank. Reciprocal rank fusion merges ranked lists without having
 * to compare their scores (BM25-style ranks and cosine similarities live on
 * different scales). The reranker then reads the query and each passage
 * together, which is the step that most improves quality in a real system.
 * @module retrieval/fuse
 */
import { concept, tokenize } from './embed.js'

export const RRF_K = 60

/** score(d) = sum over lists of 1 / (k + rank), rank starting at 1. */
export function reciprocalRankFusion(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return scores
}

export interface RerankInput {
  title: string
  text: string
  date: Date
}

/**
 * Mock cross-encoder. A real reranker is a model that scores (query, passage)
 * pairs; this one scores concept coverage, phrase matches, title hits and
 * recency, which is enough to reorder fused candidates sensibly and
 * deterministically.
 */
export function rerankScore(query: string, passage: RerankInput, now = new Date()): number {
  const queryConcepts = [...new Set(tokenize(query).map(concept))]
  if (queryConcepts.length === 0) return recency(passage.date, now)
  const passageTokens = tokenize(`${passage.title} ${passage.text}`).map(concept)
  const passageSet = new Set(passageTokens)
  const titleSet = new Set(tokenize(passage.title).map(concept))
  const coverage = queryConcepts.filter((c) => passageSet.has(c)).length / queryConcepts.length
  const bigrams = queryConcepts.slice(1).map((c, i) => `${queryConcepts[i]}|${c}`)
  const passageBigrams = new Set(passageTokens.slice(1).map((c, i) => `${passageTokens[i]}|${c}`))
  const phrase = bigrams.length ? bigrams.filter((b) => passageBigrams.has(b)).length / bigrams.length : 0
  const titleHit = queryConcepts.some((c) => titleSet.has(c)) ? 1 : 0
  return 0.55 * coverage + 0.2 * phrase + 0.15 * titleHit + 0.1 * recency(passage.date, now)
}

function recency(date: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000)
  return Math.exp(-ageDays / 30)
}
