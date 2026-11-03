/**
 * Pure helpers for the markdown renderer: lexing into top-level blocks, the
 * link protocol allowlist, and entity decoding. Kept apart from the
 * components so React Fast Refresh can treat markdown.tsx as components only.
 */
import { marked, type Token } from 'marked'

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Returns the URL if it is absolute and uses an allowed protocol, else null. */
export function safeUrl(href: string | null | undefined): URL | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return SAFE_PROTOCOLS.has(url.protocol) ? url : null
  } catch {
    return null
  }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
export const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])

export function lexBlocks(text: string): Token[] {
  return marked.lexer(text, { gfm: true }).filter((t) => t.type !== 'space' && t.type !== 'def')
}
