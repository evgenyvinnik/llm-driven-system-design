/**
 * Turns `[n]` markers in a finished answer into citations with exact spans.
 *
 * For each marker, the cited claim is the text between the previous marker
 * (or the start of the answer) and this one. When that claim occurs verbatim
 * in source n's chunk (the mock model is extractive, and a real model is
 * asked to quote), the citation points at exactly that span of the document;
 * otherwise it falls back to the whole chunk. Offsets are absolute positions
 * in the version's extracted text, so the document page can highlight them.
 * Markers that point at no source are dropped, never guessed.
 * @module api/services/citations
 */
import type { Citation, SourceRef } from './dto.js'

export function extractCitations(answer: string, sources: (SourceRef & { text: string })[]): Citation[] {
  const byN = new Map(sources.map((s) => [s.n, s]))
  const out: Citation[] = []
  const seen = new Set<string>()
  const re = /\[(\d+)\]/g
  let prevEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(answer)) !== null) {
    const n = Number(m[1])
    const claim = answer
      .slice(prevEnd, m.index)
      .replace(/^\s*Based on your documents:\s*/i, '')
      .trim()
    prevEnd = m.index + m[0].length
    const source = byN.get(n)
    if (!source) continue
    const at = claim.length > 0 ? source.text.indexOf(claim) : -1
    const charStart = at === -1 ? source.charStart : source.charStart + at
    const charEnd = at === -1 ? source.charEnd : charStart + claim.length
    const key = `${n}:${charStart}:${charEnd}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      n,
      documentId: source.documentId,
      versionId: source.versionId,
      versionNo: source.versionNo,
      title: source.title,
      chunkId: source.chunkId,
      charStart,
      charEnd,
      quote: at === -1 ? source.text.slice(0, 200) : claim,
    })
  }
  return out
}
