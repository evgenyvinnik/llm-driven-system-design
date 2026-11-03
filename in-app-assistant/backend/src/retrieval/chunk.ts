/**
 * Chunk and tag step. Passages of a few hundred tokens, split on natural
 * boundaries: one email message, or one document section. Each chunk carries
 * the metadata a citation and a permission filter need.
 * @module retrieval/chunk
 */
import { estimateTokens } from '../shared/tokens.js'

export const CHUNK_TARGET_TOKENS = 220

export interface ChunkDraft {
  position: number
  /** For docs, the first paragraph ID in the chunk, so a citation can point at it. */
  anchor: string | null
  text: string
}

/** Splits text on paragraph boundaries, packing paragraphs up to the target size. */
export function packParagraphs(paragraphs: { text: string; anchor: string | null }[]): ChunkDraft[] {
  const chunks: ChunkDraft[] = []
  let current: string[] = []
  let anchor: string | null = null
  let tokens = 0
  const flush = () => {
    if (current.length) chunks.push({ position: chunks.length, anchor, text: current.join('\n\n') })
    current = []
    anchor = null
    tokens = 0
  }
  for (const paragraph of paragraphs) {
    const size = estimateTokens(paragraph.text)
    if (tokens > 0 && tokens + size > CHUNK_TARGET_TOKENS) flush()
    if (current.length === 0) anchor = paragraph.anchor
    current.push(paragraph.text)
    tokens += size
  }
  flush()
  return chunks
}

export function chunkEmail(cleanBody: string): ChunkDraft[] {
  const paragraphs = cleanBody
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, anchor: null }))
  const chunks = packParagraphs(paragraphs)
  return chunks.length ? chunks : [{ position: 0, anchor: null, text: '(empty message)' }]
}

export interface DocParagraph {
  id: string
  kind: string
  text: string
}

/**
 * Documents split at headings first, so a chunk never straddles two sections,
 * then by size. The heading text is repeated at the top of each chunk of its
 * section, which helps both keyword and vector search.
 */
export function chunkDocument(paragraphs: DocParagraph[]): ChunkDraft[] {
  const sections: { heading: string | null; items: DocParagraph[] }[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.kind === 'title') continue
    if (paragraph.kind === 'heading' || sections.length === 0) {
      sections.push({ heading: paragraph.kind === 'heading' ? paragraph.text : null, items: [] })
      if (paragraph.kind === 'heading') {
        sections[sections.length - 1].items.push(paragraph)
        continue
      }
    }
    sections[sections.length - 1].items.push(paragraph)
  }
  const chunks: ChunkDraft[] = []
  for (const section of sections) {
    const packed = packParagraphs(section.items.map((p) => ({ text: p.text, anchor: p.id })))
    packed.forEach((chunk, i) => {
      const text = i > 0 && section.heading ? `${section.heading}\n\n${chunk.text}` : chunk.text
      chunks.push({ position: chunks.length, anchor: chunk.anchor, text })
    })
  }
  return chunks
}
