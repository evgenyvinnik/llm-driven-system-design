/**
 * Prompt templates use `{{variable}}` placeholders. Variables are detected from
 * the system and user text; values are supplied per run, so the same saved
 * version can be run against different inputs.
 * @module shared/template
 */
import { createHash } from 'node:crypto'

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** Unique variable names in order of first appearance. */
export function extractVariables(...texts: string[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(VARIABLE_PATTERN)) seen.add(match[1])
  }
  return [...seen]
}

export interface RenderResult {
  text: string
  missing: string[]
}

/** Replaces placeholders with values. Missing values are reported, not rendered as empty. */
export function renderTemplate(text: string, values: Record<string, string>): RenderResult {
  const missing = new Set<string>()
  const rendered = text.replace(VARIABLE_PATTERN, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      missing.add(name)
      return whole
    }
    return values[name]
  })
  return { text: rendered, missing: [...missing] }
}

/**
 * Content address of a prompt snapshot. Identical system + template text always
 * maps to the same snapshot row, so runs of an unsaved draft and saved versions
 * share storage and can be matched to each other.
 */
export function contentHash(systemText: string, templateText: string): string {
  return createHash('sha256').update(JSON.stringify([systemText, templateText])).digest('hex')
}

/** Stable hash of a request body, used to detect an idempotency key reused with a different request. */
export function requestHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
