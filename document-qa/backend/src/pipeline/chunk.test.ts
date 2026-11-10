import { describe, expect, it } from 'vitest'
import { chunkText } from './chunk.js'
import { markdownHeadings } from './extract.js'

const para = (n: number, topic: string) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i + 1} about ${topic} explains one more detail of the policy.`).join(' ')

describe('chunkText', () => {
  const text = `# Policy\n\n${para(12, 'expenses')}\n\n## Travel\n\n${para(10, 'travel')}\n`
  const headings = markdownHeadings(text)
  const chunks = chunkText(text, headings, { targetTokens: 40, overlapTokens: 10 })

  it('keeps exact character offsets for every chunk', () => {
    expect(chunks.length).toBeGreaterThan(4)
    for (const c of chunks) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text)
  })

  it('numbers chunks densely from zero', () => {
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it('respects the approximate token budget (single long sentences aside)', () => {
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(40 * 4 + 80)
  })

  it('overlaps consecutive chunks within a section', () => {
    const sameSection = chunks.filter((c) => c.heading === 'Policy')
    let overlaps = 0
    for (let i = 1; i < sameSection.length; i++) if (sameSection[i].charStart < sameSection[i - 1].charEnd) overlaps++
    expect(overlaps).toBeGreaterThan(0)
  })

  it('starts a new chunk at a heading, without overlap across it, and labels chunks with their heading', () => {
    const travelStart = text.indexOf('## Travel')
    const firstTravel = chunks.find((c) => c.charStart >= travelStart)
    expect(firstTravel?.charStart).toBe(travelStart)
    expect(firstTravel?.heading).toBe('Travel')
    const before = chunks.filter((c) => c.charStart < travelStart)
    for (const c of before) expect(c.charEnd).toBeLessThanOrEqual(travelStart)
  })

  it('covers every sentence of the text', () => {
    for (const marker of ['Sentence 12 about expenses', 'Sentence 10 about travel']) {
      expect(chunks.some((c) => c.text.includes(marker))).toBe(true)
    }
  })

  it('is deterministic, which is what makes a redo write the same rows', () => {
    expect(chunkText(text, headings, { targetTokens: 40, overlapTokens: 10 })).toEqual(chunks)
  })

  it('never emits a chunk contained in the previous one', () => {
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].charEnd).toBeGreaterThan(chunks[i - 1].charEnd)
  })

  it('splits a single sentence longer than the target at whitespace', () => {
    const long = `${'word '.repeat(200).trim()}.`
    const out = chunkText(long, [], { targetTokens: 30, overlapTokens: 0 })
    expect(out.length).toBeGreaterThan(5)
    for (const c of out) expect(long.slice(c.charStart, c.charEnd)).toBe(c.text)
  })

  it('returns nothing for blank text', () => {
    expect(chunkText('   \n\n  ', [], { targetTokens: 30, overlapTokens: 5 })).toEqual([])
  })
})
