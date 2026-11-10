/**
 * The access model, in one place.
 *
 * A user may read a document when, right now:
 * - the user is active and belongs to the document's org (tenant),
 * - the document is not tombstoned, and
 * - the user owns it, or its scope is `org`, or its scope is `group` and the
 *   user is a member of that group (read live from `group_members`).
 *
 * `accessDecision` is the pure rule (unit-tested); `readableSql` is the same
 * rule as a SQL predicate for list queries. Both read the source of truth.
 * The index's copy of scope/group is only ever a pre-filter.
 * @module shared/access
 */

export type Scope = 'private' | 'group' | 'org'

export interface AccessUser {
  id: string
  orgId: string | null
  active: boolean
}

export interface DocAccess {
  orgId: string
  ownerId: string
  scope: Scope
  groupId: string | null
  deletedAt: Date | string | null
}

export type DenyReason = 'deleted' | 'other_tenant' | 'user_inactive' | 'not_owner' | 'not_in_group'

export type AccessResult = { allowed: true } | { allowed: false; reason: DenyReason }

export function accessDecision(doc: DocAccess, user: AccessUser, memberOf: ReadonlySet<string>): AccessResult {
  if (!user.active) return { allowed: false, reason: 'user_inactive' }
  if (user.orgId === null || doc.orgId !== user.orgId) return { allowed: false, reason: 'other_tenant' }
  if (doc.deletedAt !== null) return { allowed: false, reason: 'deleted' }
  if (doc.ownerId === user.id) return { allowed: true }
  if (doc.scope === 'org') return { allowed: true }
  if (doc.scope === 'group') return doc.groupId !== null && memberOf.has(doc.groupId) ? { allowed: true } : { allowed: false, reason: 'not_in_group' }
  return { allowed: false, reason: 'not_owner' }
}

/**
 * SQL predicate for "user can read document `alias`". `$org` and `$user` are
 * placeholders the caller substitutes with its own parameter numbers.
 */
export function readableSql(alias: string, orgParam: string, userParam: string): string {
  return `(${alias}.org_id = ${orgParam} AND ${alias}.deleted_at IS NULL AND (
      ${alias}.owner_id = ${userParam}
      OR ${alias}.scope = 'org'
      OR (${alias}.scope = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ${alias}.group_id AND gm.user_id = ${userParam}))
    ))`
}
