/**
 * Masks secret values in a stream of log text. Used twice: by the runner before
 * a chunk leaves the machine, and by the API when assembling chunks into lines,
 * so a runner that forgets (or a chunk from an older runner version) doesn't put
 * a value into storage.
 *
 * The stream problem: a value can be split across two chunks. So text is buffered
 * until its line is complete and masked a whole line at a time. A line with no
 * newline for a long time is flushed in pieces, always holding back enough that a
 * value straddling the cut stays whole in the buffer.
 *
 * This is hygiene, not a security boundary. A step that holds a secret can print it
 * reversed, in hex, or a character per line. That is why untrusted code never gets
 * a secret in the first place.
 * @module secrets/masking
 */

export const MASK = '***'
const DEFAULT_MAX_LINE = 16 * 1024
/** Below this length a "secret" would mask ordinary words and destroy the log. */
const MIN_MASKABLE = 4

/** The value, each line of a multi-line value, and the encodings a shell step commonly produces. */
export function maskVariants(values: string[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    if (value.length < MIN_MASKABLE) continue
    out.add(value)
    for (const line of value.split(/\r?\n/)) if (line.length >= MIN_MASKABLE) out.add(line)
    out.add(Buffer.from(value, 'utf8').toString('base64'))
    out.add(Buffer.from(value, 'utf8').toString('base64url'))
    const percent = encodeURIComponent(value)
    if (percent !== value) out.add(percent)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

export function maskText(text: string, variants: string[]): string {
  let out = text
  for (const v of variants) if (out.includes(v)) out = out.split(v).join(MASK)
  return out
}

export class StreamMasker {
  private readonly variants: string[]
  private readonly holdBack: number
  private readonly maxLine: number

  /** `partial` restores a previous state, so assembly can continue on another API instance. */
  constructor(values: string[], partial = '', maxLine = DEFAULT_MAX_LINE) {
    this.variants = maskVariants(values)
    this.holdBack = this.variants.reduce((max, v) => Math.max(max, v.length - 1), 0)
    this.maxLine = Math.max(maxLine, this.holdBack * 2 + 1)
    this.buffer = partial
  }

  private buffer: string

  /** Text not yet emitted. May contain part of a secret: never store or show it as is. */
  get partial(): string {
    return this.buffer
  }

  /** Feeds text and returns every line that is now complete, masked. */
  feed(text: string): string[] {
    this.buffer += text.replace(/\r\n/g, '\n')
    const lines: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      lines.push(maskText(this.buffer.slice(0, newline), this.variants))
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
    }
    while (this.buffer.length > this.maxLine) {
      // Mask first: anything whole is gone, and anything split can only be in the last holdBack characters.
      const masked = maskText(this.buffer, this.variants)
      if (masked.length <= this.maxLine) {
        this.buffer = masked
        break
      }
      const cut = Math.max(1, masked.length - this.holdBack)
      lines.push(masked.slice(0, cut))
      this.buffer = masked.slice(cut)
    }
    return lines
  }

  /** The stream ended: whatever is left is the last line. */
  flush(): string[] {
    if (this.buffer.length === 0) return []
    const last = maskText(this.buffer, this.variants)
    this.buffer = ''
    return [last]
  }
}
