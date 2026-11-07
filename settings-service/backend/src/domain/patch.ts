/**
 * Patch planning: the exact PATCH contract as a pure function.
 *
 * A user PATCH is a JSON merge patch over the flat key → value map: a value
 * sets the user's choice, `null` clears it (back to inherited). It is atomic:
 * every key applies or none does. For each key, in order:
 *
 *   1. unknown key                 → 422 UNKNOWN_KEY
 *   2. retired key (past sunset)   → 422 RETIRED
 *   3. deprecated key (in grace)   → accepted and ignored, with a warning
 *   4. org-scoped key              → 422 NOT_USER_WRITABLE
 *   5. invalid value               → 422 INVALID_TYPE / NOT_ALLOWED / OUT_OF_RANGE / TOO_LONG / INVALID_FORMAT
 *   6. key enforced by the org     → 422 LOCKED
 *   7. stored value already equal  → unchanged (no-op; this is what makes a retry after a lost response safe)
 *   8. key changed after If-Match  → 409 conflict (someone else wrote this key since the client's base revision)
 *   9. otherwise                   → change
 *
 * Step 8 compares the KEY's last-changed revision with the client's base
 * revision, not the whole document's revision. Two devices that both read
 * revision 12 and change different keys both succeed; the same key conflicts.
 * @module domain/patch
 */
import { keyStatus } from './resolve.js'
import type { Definition, FieldError, KeyConflict, OrgValue, PatchWarning, SettingValue, UserValue } from './types.js'
import { isSettingValue, validateValue } from './validate.js'

/** `'*'` is an explicit unconditional write (the client opts into last-write-wins). */
export type BaseRevision = number | '*'

export interface PlannedChange {
  key: string
  value: SettingValue | null
  previous: SettingValue | null
}

export type UserPatchPlan =
  | { kind: 'invalid'; errors: FieldError[]; warnings: PatchWarning[] }
  | { kind: 'conflict'; conflicts: KeyConflict[]; warnings: PatchWarning[] }
  | { kind: 'ok'; changes: PlannedChange[]; unchanged: string[]; warnings: PatchWarning[] }

export interface UserPatchInput {
  defs: Map<string, Definition>
  orgRows: Map<string, OrgValue>
  userRows: Map<string, UserValue>
  baseRevision: BaseRevision
  patch: Record<string, unknown>
  now: Date
}

export function planUserPatch({ defs, orgRows, userRows, baseRevision, patch, now }: UserPatchInput): UserPatchPlan {
  const errors: FieldError[] = []
  const warnings: PatchWarning[] = []
  const candidates: Array<{ key: string; value: SettingValue | null }> = []

  for (const [key, raw] of Object.entries(patch)) {
    const def = defs.get(key)
    if (!def) {
      errors.push({ key, code: 'UNKNOWN_KEY', message: 'No such setting' })
      continue
    }
    const status = keyStatus(def, now)
    if (status === 'retired') {
      errors.push({
        key,
        code: 'RETIRED',
        message: def.replacedBy ? `This setting was retired; use ${def.replacedBy}` : 'This setting was retired',
        replacedBy: def.replacedBy,
      })
      continue
    }
    if (status === 'deprecated') {
      warnings.push({
        key,
        code: 'DEPRECATED_IGNORED',
        message: def.replacedBy
          ? `Deprecated and ignored; use ${def.replacedBy}. Writes are rejected after the sunset date.`
          : 'Deprecated and ignored. Writes are rejected after the sunset date.',
        replacedBy: def.replacedBy,
        sunsetAt: def.sunsetAt ? def.sunsetAt.toISOString() : null,
      })
      continue
    }
    if (def.scope === 'org') {
      errors.push({ key, code: 'NOT_USER_WRITABLE', message: 'Only your organization can change this setting' })
      continue
    }
    if (raw !== null) {
      const invalid = validateValue(def, raw)
      if (invalid) {
        errors.push(invalid)
        continue
      }
    }
    const org = orgRows.get(key)
    if (org && org.enforced && org.value !== null) {
      errors.push({ key, code: 'LOCKED', message: 'Your organization enforces this setting' })
      continue
    }
    candidates.push({ key, value: raw === null ? null : (raw as SettingValue) })
  }

  if (errors.length > 0) return { kind: 'invalid', errors, warnings }

  const changes: PlannedChange[] = []
  const unchanged: string[] = []
  const conflicts: KeyConflict[] = []
  for (const { key, value } of candidates) {
    const row = userRows.get(key)
    const current = row ? row.value : null
    if (current === value) {
      unchanged.push(key)
      continue
    }
    const changedAt = row?.rev ?? 0
    if (baseRevision !== '*' && changedAt > baseRevision) {
      conflicts.push({
        key,
        baseRevision,
        changedAtRevision: changedAt,
        yourValue: value,
        currentValue: current,
        changedBy: row?.updatedBy ?? null,
      })
      continue
    }
    changes.push({ key, value, previous: current })
  }

  if (conflicts.length > 0) return { kind: 'conflict', conflicts, warnings }
  return { kind: 'ok', changes, unchanged, warnings }
}

/** Desired org policy for one key; `null` clears it. */
export interface OrgPolicyInput {
  value: unknown
  enforced: boolean
}

export type OrgChangePlan =
  | { kind: 'invalid'; error: FieldError }
  | { kind: 'conflict'; changedAtRevision: number }
  | { kind: 'unchanged' }
  | { kind: 'change'; value: SettingValue | null; enforced: boolean; previous: OrgValue | undefined }

export function planOrgChange(
  def: Definition | undefined,
  key: string,
  current: OrgValue | undefined,
  baseRevision: BaseRevision,
  next: OrgPolicyInput | null,
  now: Date,
): OrgChangePlan {
  if (!def) return { kind: 'invalid', error: { key, code: 'UNKNOWN_KEY', message: 'No such setting' } }
  const status = keyStatus(def, now)
  if (status === 'retired') return { kind: 'invalid', error: { key, code: 'RETIRED', message: 'This setting was retired' } }
  if (status === 'deprecated' && next !== null) {
    return { kind: 'invalid', error: { key, code: 'DEPRECATED', message: 'Deprecated settings can only have their policy cleared' } }
  }
  let value: SettingValue | null = null
  let enforced = false
  if (next !== null) {
    if (!isSettingValue(next.value)) return { kind: 'invalid', error: { key, code: 'INVALID_TYPE', message: 'A policy needs a value' } }
    const invalid = validateValue(def, next.value)
    if (invalid) return { kind: 'invalid', error: invalid }
    value = next.value
    // Org-scoped keys are always locked for users; the enforced flag only means something for user-scoped keys.
    enforced = def.scope === 'user' ? next.enforced : false
  }
  const currentValue = current ? current.value : null
  const currentEnforced = current && current.value !== null ? current.enforced : false
  if (currentValue === value && currentEnforced === enforced) return { kind: 'unchanged' }
  if (baseRevision !== '*' && current && current.rev > baseRevision) return { kind: 'conflict', changedAtRevision: current.rev }
  return { kind: 'change', value, enforced, previous: current }
}

/** Parses an If-Match header: `"12"`, `12`, `W/"12"` → 12; `*` → '*'; anything else → null. */
export function parseIfMatch(header: string | undefined): BaseRevision | null {
  if (header === undefined) return null
  const trimmed = header.trim()
  if (trimmed === '*') return '*'
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(trimmed)
  return m ? Number(m[1]) : null
}
