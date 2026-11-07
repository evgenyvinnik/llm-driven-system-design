/**
 * Dataset case identity, hashing and version diffs. Pure.
 *
 * A case keeps its `caseKey` across versions; its content hash covers the
 * input variables, the reference and the tags. Two versions share a case when
 * the key AND the hash match: a case whose reference was corrected is a
 * different case for scoring purposes, even though its key is the same.
 * @module shared/dataset-diff
 */
import { createHash } from 'node:crypto'

export interface CaseContent {
  input: Record<string, unknown>
  reference: string
  tags: string[]
}

export interface KeyedCase extends CaseContent {
  caseKey: string
}

/** Stable JSON: object keys sorted, so {a,b} and {b,a} hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function caseHash(c: CaseContent): string {
  const tags = [...c.tags].sort()
  return createHash('sha256').update(canonicalJson({ input: c.input, reference: c.reference, tags })).digest('hex')
}

/** Hash of a whole version: its case hashes in key order. */
export function versionHash(cases: readonly KeyedCase[]): string {
  const parts = [...cases].sort((a, b) => (a.caseKey < b.caseKey ? -1 : 1)).map((c) => `${c.caseKey}:${caseHash(c)}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

export type FieldChange = 'input' | 'reference' | 'tags'

export interface CaseDiff {
  added: KeyedCase[]
  removed: KeyedCase[]
  modified: { caseKey: string; fields: FieldChange[]; from: KeyedCase; to: KeyedCase }[]
  unchanged: number
}

export function diffCases(from: readonly KeyedCase[], to: readonly KeyedCase[]): CaseDiff {
  const before = new Map(from.map((c) => [c.caseKey, c]))
  const after = new Map(to.map((c) => [c.caseKey, c]))
  const diff: CaseDiff = { added: [], removed: [], modified: [], unchanged: 0 }
  for (const c of to) {
    const old = before.get(c.caseKey)
    if (!old) {
      diff.added.push(c)
      continue
    }
    const fields: FieldChange[] = []
    if (canonicalJson(old.input) !== canonicalJson(c.input)) fields.push('input')
    if (old.reference !== c.reference) fields.push('reference')
    if (canonicalJson([...old.tags].sort()) !== canonicalJson([...c.tags].sort())) fields.push('tags')
    if (fields.length > 0) diff.modified.push({ caseKey: c.caseKey, fields, from: old, to: c })
    else diff.unchanged++
  }
  for (const c of from) if (!after.has(c.caseKey)) diff.removed.push(c)
  return diff
}

/** Next free key in the `prefix-NNN` sequence, for cases added in a new version. */
export function nextCaseKey(existing: Iterable<string>, prefix: string): string {
  let max = 0
  for (const key of existing) {
    const m = key.match(/-(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}
