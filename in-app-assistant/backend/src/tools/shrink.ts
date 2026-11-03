/**
 * Result shaping. Raw API responses are often huge; the model pays for every
 * token it reads, every step after. Long strings are cut and long lists are
 * trimmed from the end, but item IDs survive, and the result says plainly
 * that there is more and how to get it.
 * @module tools/shrink
 */
import { estimateTokens } from '../shared/tokens.js'

const MAX_STRING = 1500

function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated; ask for detail "full" or page with a cursor]` : value
  }
  if (Array.isArray(value)) return value.map(truncateStrings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v)]))
  }
  return value
}

export function shrink(content: Record<string, unknown>, maxTokens: number): { content: Record<string, unknown>; trimmed: boolean } {
  let out = truncateStrings(content) as Record<string, unknown>
  let trimmed = JSON.stringify(out) !== JSON.stringify(content)
  if (estimateTokens(out) <= maxTokens) return { content: out, trimmed }
  out = structuredClone(out)
  const arrays = Object.entries(out).filter(([, v]) => Array.isArray(v)) as [string, unknown[]][]
  const originalLengths = Object.fromEntries(arrays.map(([k, v]) => [k, v.length]))
  while (estimateTokens(out) > maxTokens) {
    const largest = arrays.filter(([, v]) => v.length > 1).sort((a, b) => estimateTokens(b[1]) - estimateTokens(a[1]))[0]
    if (!largest) break
    largest[1].pop()
    trimmed = true
  }
  for (const [key, list] of arrays) {
    const omitted = originalLengths[key] - list.length
    if (omitted > 0) out[`${key}_omitted`] = `${omitted} more not shown; narrow the query or request a smaller page`
  }
  return { content: out, trimmed }
}
