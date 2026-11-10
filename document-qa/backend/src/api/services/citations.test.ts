import { describe, expect, it } from 'vitest'
import { extractCitations } from './citations.js'

const doc = 'Intro line.\n\nSubmit expense claims within 30 days of the purchase. Attach a receipt.'
const chunkStart = doc.indexOf('Submit')
const source = {
  n: 1,
  documentId: 'doc_1',
  versionId: 'ver_1',
  versionNo: 1,
  title: 'Expense policy',
  chunkId: 'chk_1',
  ordinal: 0,
  heading: null,
  charStart: chunkStart,
  charEnd: doc.length,
  text: doc.slice(chunkStart),
}

describe('extractCitations', () => {
  it('maps a marker to the exact cited span in the document', () => {
    const [c] = extractCitations('Based on your documents: Submit expense claims within 30 days of the purchase. [1]', [source])
    expect(doc.slice(c.charStart, c.charEnd)).toBe('Submit expense claims within 30 days of the purchase.')
    expect(c).toMatchObject({ n: 1, documentId: 'doc_1', versionId: 'ver_1' })
  })

  it('falls back to the whole chunk when the claim is a paraphrase', () => {
    const [c] = extractCitations('You have a month to file. [1]', [source])
    expect([c.charStart, c.charEnd]).toEqual([source.charStart, source.charEnd])
  })

  it('drops markers that point at no source and dedupes repeats', () => {
    const out = extractCitations('Attach a receipt. [1] Attach a receipt. [1] Something else. [7]', [source])
    expect(out).toHaveLength(1)
  })
})
