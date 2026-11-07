/**
 * The mock model's "reasoning": a deterministic extractive answer.
 *
 * It reads the numbered `<source id="n">` blocks and the question out of the
 * prompt, scores every source sentence by how many of the question's terms
 * it contains, and answers with the best sentences verbatim, each followed by
 * its citation marker `[n]`. Verbatim sentences let the API locate the exact
 * cited span inside the chunk. When no sentence is relevant enough (or no
 * sources were provided) it says the answer was not found in your documents.
 * @module model/answer
 */
import { splitSentences, terms } from '../shared/text.js'

export const NOT_FOUND = 'That information was not found in your documents.'

export interface ParsedPrompt {
  sources: { id: number; text: string }[]
  question: string
}

export function parsePrompt(content: string): ParsedPrompt {
  const sources: { id: number; text: string }[] = []
  const re = /<source id="(\d+)"[^>]*>([\s\S]*?)<\/source>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) sources.push({ id: Number(m[1]), text: m[2] })
  const q = /Question:\s*([\s\S]*)$/.exec(content)
  return { sources, question: (q ? q[1] : content).trim() }
}

interface Scored {
  sourceId: number
  position: number
  text: string
  score: number
}

export function composeAnswer(prompt: ParsedPrompt, maxSentences = 3): string {
  const qTerms = new Set(terms(prompt.question))
  if (qTerms.size === 0 || prompt.sources.length === 0) return NOT_FOUND
  const scored: Scored[] = []
  for (const source of prompt.sources) {
    splitSentences(source.text).forEach((s, position) => {
      // Skip headings: markdown "#" lines, and short lines without sentence punctuation ("Q3 Budget Plan").
      if (s.text.startsWith('#') || s.text.length < 12) return
      if (!/[.!?]$/.test(s.text) && s.text.split(/\s+/).length < 8) return
      const hits = new Set(terms(s.text).filter((t) => qTerms.has(t)))
      if (hits.size > 0) scored.push({ sourceId: source.id, position, text: s.text, score: hits.size })
    })
  }
  if (scored.length === 0) return NOT_FOUND
  const best = Math.max(...scored.map((s) => s.score))
  const threshold = Math.max(1, Math.ceil(qTerms.size * 0.34), Math.ceil(best * 0.6))
  if (best < threshold) return NOT_FOUND
  const seen = new Set<string>()
  const picked = scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score || a.sourceId - b.sourceId || a.position - b.position)
    .filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true)))
    .slice(0, maxSentences)
    .sort((a, b) => a.sourceId - b.sourceId || a.position - b.position)
  return `Based on your documents: ${picked.map((s) => `${s.text} [${s.sourceId}]`).join(' ')}`
}

/** Splits an answer into stream tokens (a word plus its trailing whitespace). */
export function streamTokens(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}
