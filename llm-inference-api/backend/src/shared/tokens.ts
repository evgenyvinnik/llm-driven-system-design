/**
 * Token estimation. A real gateway runs the model's tokenizer; ~4 characters
 * per token is close enough for admission, and the mock backends count input
 * with the same function, so input estimates are exact here and the only
 * uncertainty is output length (which is why admission reserves max_tokens).
 * @module shared/tokens
 */
import { createHash } from 'node:crypto'

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return Math.max(1, Math.ceil(text.length / 4))
}

export function sha(text: string, length = 16): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length)
}

/** 32-bit FNV-1a, used for the hash ring and deterministic token generation. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
