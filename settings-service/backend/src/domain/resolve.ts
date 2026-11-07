/**
 * Effective-value resolution. One rule, applied per key:
 *
 *   org-scoped key:  org value > global default            (always locked)
 *   user-scoped key: enforced org value > user value > org default > global default
 *
 * Users store only explicit choices (sparse rows), so a definition added at
 * runtime resolves to its default for every existing user with no backfill.
 * @module domain/resolve
 */
import type { Definition, EffectiveEntry, KeyStatus, OrgValue, UserValue } from './types.js'

export function keyStatus(def: Pick<Definition, 'deprecatedAt' | 'sunsetAt'>, now: Date): KeyStatus {
  if (def.sunsetAt && def.sunsetAt.getTime() <= now.getTime()) return 'retired'
  if (def.deprecatedAt && def.deprecatedAt.getTime() <= now.getTime()) return 'deprecated'
  return 'active'
}

export function resolveEntry(def: Definition, org: OrgValue | undefined, user: UserValue | undefined): EffectiveEntry {
  const orgValue = org && org.value !== null ? org.value : undefined
  const userValue = user && user.value !== null ? user.value : undefined
  const meta = user
    ? { rev: user.rev, updatedAt: user.updatedAt.toISOString(), ...(user.updatedBy ? { updatedBy: user.updatedBy } : {}) }
    : { rev: 0 }

  if (def.scope === 'org') {
    return orgValue !== undefined
      ? { value: orgValue, source: 'org', locked: true, lockReason: 'org_scope', rev: 0 }
      : { value: def.defaultValue, source: 'default', locked: true, lockReason: 'org_scope', rev: 0 }
  }
  if (orgValue !== undefined && org!.enforced) {
    return {
      value: orgValue,
      source: 'enforced',
      locked: true,
      lockReason: 'enforced',
      ...meta,
      ...(userValue !== undefined ? { userValue } : {}),
    }
  }
  if (userValue !== undefined) return { value: userValue, source: 'user', locked: false, lockReason: null, ...meta }
  if (orgValue !== undefined) return { value: orgValue, source: 'org', locked: false, lockReason: null, ...meta }
  return { value: def.defaultValue, source: 'default', locked: false, lockReason: null, ...meta }
}

/**
 * Resolves every non-retired key. Deprecated keys are still returned (flagged),
 * so an old client that reads them keeps working through the grace window.
 */
export function resolveAll(
  defs: Iterable<Definition>,
  orgRows: Map<string, OrgValue>,
  userRows: Map<string, UserValue>,
  now: Date,
): Record<string, EffectiveEntry> {
  const out: Record<string, EffectiveEntry> = {}
  for (const def of defs) {
    const status = keyStatus(def, now)
    if (status === 'retired') continue
    const entry = resolveEntry(def, orgRows.get(def.key), userRows.get(def.key))
    out[def.key] = status === 'deprecated' ? { ...entry, deprecated: true } : entry
  }
  return out
}
