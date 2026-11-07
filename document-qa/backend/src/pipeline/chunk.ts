/**
 * Chunk stage, pure part: extracted text → overlapping chunks with exact
 * character offsets, so a citation can highlight the precise source span.
 *
 * - Units are sentences (and newline-delimited lines); a sentence longer than
 *   the target is split at whitespace.
 * - A chunk accumulates units up to ~`targetTokens` (≈ 4 chars per token).
 * - The next chunk re-starts on whole sentences covering ~`overlapTokens` of
 *   the previous chunk's tail (at least its last sentence, if that is shorter
 *   than half a chunk), so an answer that spans a boundary is still inside
 *   one chunk.
 * - A heading starts a new chunk with no overlap, and every chunk records the
 *   heading it falls under.
 *
 * Invariant (unit-tested): `text.slice(c.charStart, c.charEnd) === c.text`.
 * The output is a pure function of the text and settings, which is what lets
 * the chunk stage be redone after a crash and upsert the same rows.
 * @module pipeline/chunk
 */
import { estimateTokens, splitSentences, type Sentence } from '../shared/text.js'
import type { Heading } from './extract.js'

export interface ChunkSpec {
  ordinal: number
  text: string
  charStart: number
  charEnd: number
  heading: string | null
  tokenCount: number
}

export interface ChunkOptions {
  targetTokens: number
  overlapTokens: number
}

const CHARS_PER_TOKEN = 4

function splitLong(text: string, unit: Sentence, maxChars: number): Sentence[] {
  if (unit.end - unit.start <= maxChars) return [unit]
  const pieces: Sentence[] = []
  let start = unit.start
  while (start < unit.end) {
    let end = Math.min(unit.end, start + maxChars)
    if (end < unit.end) {
      const space = text.lastIndexOf(' ', end)
      if (space > start + maxChars / 2) end = space
    }
    const raw = text.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed) pieces.push({ text: trimmed, start: start + lead, end: start + lead + trimmed.length })
    start = end
  }
  return pieces
}

export function chunkText(text: string, headings: Heading[], opts: ChunkOptions): ChunkSpec[] {
  const targetChars = Math.max(40, opts.targetTokens * CHARS_PER_TOKEN)
  const overlapChars = Math.max(0, Math.min(opts.overlapTokens * CHARS_PER_TOKEN, targetChars / 2))
  const units = splitSentences(text).flatMap((u) => splitLong(text, u, targetChars))
  if (units.length === 0) return []

  const sorted = [...headings].sort((a, b) => a.charStart - b.charStart)
  // Section index of each unit: how many headings start at or before it.
  const section = units.map((u) => {
    let n = 0
    while (n < sorted.length && sorted[n].charStart <= u.start) n++
    return n
  })
  const headingFor = (charStart: number): string | null => {
    let found: string | null = null
    for (const h of sorted) {
      if (h.charStart <= charStart) found = h.text
      else break
    }
    return found
  }

  const chunks: ChunkSpec[] = []
  let i = 0
  let prevEnd = -1
  while (i < units.length) {
    let j = i
    // Always cover at least one unit past the previous chunk, then grow to the target.
    while (j <= prevEnd && j + 1 < units.length && section[j + 1] === section[i]) j++
    while (j + 1 < units.length && section[j + 1] === section[i] && units[j + 1].end - units[i].start <= targetChars) j++
    const charStart = units[i].start
    const charEnd = units[j].end
    const chunkTextValue = text.slice(charStart, charEnd)
    chunks.push({
      ordinal: chunks.length,
      text: chunkTextValue,
      charStart,
      charEnd,
      heading: headingFor(charStart),
      tokenCount: estimateTokens(chunkTextValue),
    })
    prevEnd = j
    if (j + 1 >= units.length) break
    // A section boundary next: start clean, no overlap across headings.
    if (section[j + 1] !== section[i]) {
      i = j + 1
      continue
    }
    let k = j + 1
    while (k - 1 > i && charEnd - units[k - 1].start <= overlapChars) k--
    // No whole sentence fits the overlap budget: still repeat the last sentence if it is short enough,
    // so a claim that straddles the boundary is whole in at least one chunk.
    if (overlapChars > 0 && k === j + 1 && j > i && charEnd - units[j].start <= targetChars / 2) k = j
    i = k
  }
  return chunks
}
