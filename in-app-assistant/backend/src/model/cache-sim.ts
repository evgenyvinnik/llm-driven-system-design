/**
 * Prompt cache simulation. A real provider caches the longest previously seen
 * prefix of tools → system → messages for a few minutes, and bills cached
 * input tokens at a fraction of the price. This keeps hashes of every prefix
 * it has served and reports `cache_read_input_tokens` the same way, so the
 * orchestrator's choices (a frozen system prompt and tool list, volatile
 * details only at the end) show up as a measurable hit rate.
 * @module model/cache-sim
 */
import { createHash } from 'node:crypto'
import { estimateTokens } from '../shared/tokens.js'

const TTL_MS = 5 * 60_000
const MIN_CACHEABLE = 1024
const seen = new Map<string, number>()

export interface CacheUsage {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function simulateCache(model: string, tools: unknown, system: unknown, messages: unknown[]): CacheUsage {
  const now = Date.now()
  for (const [key, expires] of seen) if (expires < now) seen.delete(key)
  const hash = createHash('sha256').update(model).update(JSON.stringify(tools ?? [])).update(JSON.stringify(system ?? ''))
  const boundaries: { key: string; tokens: number }[] = []
  let tokens = estimateTokens(tools ?? []) + estimateTokens(system ?? '')
  boundaries.push({ key: hash.copy().digest('hex'), tokens })
  for (const message of messages) {
    hash.update(JSON.stringify(message))
    tokens += estimateTokens(message)
    boundaries.push({ key: hash.copy().digest('hex'), tokens })
  }
  const total = tokens
  let read = 0
  for (const boundary of boundaries) if (seen.has(boundary.key) && boundary.tokens >= MIN_CACHEABLE) read = boundary.tokens
  // Everything up to the end of this request is written for next time (automatic caching).
  for (const boundary of boundaries) if (boundary.tokens >= MIN_CACHEABLE) seen.set(boundary.key, now + TTL_MS)
  const written = total >= MIN_CACHEABLE ? total - read : 0
  return { input_tokens: total - read - written, cache_read_input_tokens: read, cache_creation_input_tokens: written }
}
