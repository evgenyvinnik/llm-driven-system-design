/**
 * Parse and clean step of the indexing pipeline. Emails are mostly not new
 * text: each reply quotes the whole thread, and every message ends in a
 * signature and often a legal footer. Without stripping those, each reply
 * re-indexes the conversation and duplicates crowd out real results.
 *
 * Cleaning is for retrieval quality, not security. Text that tries to
 * instruct the assistant survives it by design; the policy engine is what
 * stops it from acting on that text.
 * @module retrieval/clean
 */

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity] ?? ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const QUOTE_HEADER = /^(on .{3,200} wrote:|-{2,}\s*original message\s*-{2,}|from: .+ sent: .+)$/i
const FOOTER = /(confidentiality notice|this (e-?mail|message) and any attachments|to unsubscribe|unsubscribe from these emails)/i

/** Removes quoted earlier messages ("On Tue, Dana wrote:" and "> " lines). */
export function stripQuotedReplies(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (QUOTE_HEADER.test(line.trim())) break
    if (line.trimStart().startsWith('>')) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

/** Cuts at the conventional "-- " signature delimiter or a "Sent from my" line. */
export function stripSignature(text: string): string {
  const lines = text.split('\n')
  const cut = lines.findIndex((line) => line === '-- ' || line.trim() === '--' || /^sent from my /i.test(line.trim()))
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim()
}

export function stripFooters(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => !FOOTER.test(paragraph))
    .join('\n\n')
    .trim()
}

export function cleanEmailBody(bodyText: string, bodyHtml?: string | null): string {
  const raw = bodyText?.trim() ? bodyText : htmlToText(bodyHtml ?? '')
  return stripFooters(stripSignature(stripQuotedReplies(raw.replace(/\r\n/g, '\n'))))
}
