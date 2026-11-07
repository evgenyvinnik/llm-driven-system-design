/**
 * Extract stage, pure part: bytes → normalized text + headings.
 *
 * Supported: .txt, .md/.markdown (kept verbatim, so citation offsets index
 * straight into the uploaded file) and .html/.htm (markup stripped; offsets
 * index into the extracted text the document page shows). PDF is not built.
 *
 * Corrupt input fails with a reason and is classed permanent, so the job goes
 * straight to failed instead of burning retries on bytes that will never parse.
 * @module pipeline/extract
 */

export type FileKind = 'text' | 'markdown' | 'html'

export interface Heading {
  level: number
  text: string
  charStart: number
}

export interface Extracted {
  text: string
  headings: Heading[]
}

/** A failure that no retry can fix (corrupt or unsupported bytes). */
export class PermanentError extends Error {
  readonly permanent = true
}

const KIND_BY_EXT: Record<string, FileKind> = {
  txt: 'text',
  text: 'text',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
}

export const MIME_BY_KIND: Record<FileKind, string> = {
  text: 'text/plain',
  markdown: 'text/markdown',
  html: 'text/html',
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

/** The kind for a filename, or null when the type is not supported. */
export function kindOf(filename: string): FileKind | null {
  return KIND_BY_EXT[extensionOf(filename)] ?? null
}

export function unsupportedReason(filename: string): string {
  const ext = extensionOf(filename)
  if (ext === 'pdf') return 'PDF extraction is not enabled in this build. Supported types: .txt, .md, .html'
  return `Unsupported file type ${ext ? `.${ext}` : '(no extension)'}. Supported types: .txt, .md, .html`
}

/** Strict UTF-8 decode; binary content (NUL bytes) or invalid sequences are corrupt input. */
export function decodeUtf8(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0)
  if (nul !== -1) throw new PermanentError(`File looks binary, not text (NUL byte at offset ${nul})`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new PermanentError('File is not valid UTF-8 text')
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

const BLOCK = /^(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|br|hr|blockquote|pre|main|nav|aside|title)$/i

/** Strips markup, keeping block structure as line breaks and h1-h6 as headings. */
export function htmlToText(html: string): Extracted {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
  const lines: string[] = []
  const headings: Heading[] = []
  let current = ''
  let inHeading: number | null = null
  let headingText = ''
  const flush = () => {
    const line = decodeEntities(current).replace(/\s+/g, ' ').trim()
    if (line) lines.push(line)
    current = ''
  }
  const tagRe = /<\/?([a-z0-9]+)\b[^>]*>/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(body)) !== null) {
    const chunk = body.slice(last, m.index)
    current += chunk
    if (inHeading !== null) headingText += chunk
    last = m.index + m[0].length
    const tag = m[1].toLowerCase()
    const closing = m[0][1] === '/'
    if (/^h[1-6]$/.test(tag)) {
      if (!closing) {
        flush()
        inHeading = Number(tag[1])
        headingText = ''
      } else if (inHeading !== null) {
        const text = decodeEntities(headingText).replace(/\s+/g, ' ').trim()
        flush()
        if (text) headings.push({ level: inHeading, text, charStart: -1 })
        inHeading = null
      }
      continue
    }
    if (BLOCK.test(tag)) flush()
  }
  current += body.slice(last)
  flush()
  if (/<[a-z!/][^>]*$/i.test(body.slice(last)) && lines.length === 0) throw new PermanentError('HTML is truncated or malformed (unterminated tag)')
  // Paragraph breaks between block lines; then locate each heading in the output.
  const text = lines.join('\n\n')
  let cursor = 0
  for (const h of headings) {
    const at = text.indexOf(h.text, cursor)
    h.charStart = at === -1 ? 0 : at
    if (at !== -1) cursor = at + h.text.length
  }
  return { text, headings }
}

/** Markdown is kept verbatim; ATX headings (# Title) are recorded with their offsets. */
export function markdownHeadings(text: string): Heading[] {
  const headings: Heading[] = []
  const re = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) headings.push({ level: m[1].length, text: m[2].trim(), charStart: m.index })
  return headings
}

/** Plain text: a short line followed by a blank line and starting with a capital is treated as a heading. */
export function plainHeadings(text: string): Heading[] {
  const headings: Heading[] = []
  const re = /^([A-Z][^\n.!?]{2,60})\n(?=\s*\n)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) headings.push({ level: 2, text: m[1].trim(), charStart: m.index })
  return headings
}

export function extract(bytes: Uint8Array, kind: FileKind): Extracted {
  if (bytes.length === 0) throw new PermanentError('File is empty')
  const raw = decodeUtf8(bytes).replace(/\r\n?/g, '\n')
  let result: Extracted
  if (kind === 'html') result = htmlToText(raw)
  else if (kind === 'markdown') result = { text: raw, headings: markdownHeadings(raw) }
  else result = { text: raw, headings: plainHeadings(raw) }
  if (result.text.trim().length === 0) throw new PermanentError('No text content found after extraction')
  return result
}
