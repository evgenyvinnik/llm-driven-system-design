/**
 * Repository access. A user is a member of a repository as `maintainer` or
 * `read`; a platform admin can read everything and act on nothing's secrets
 * (see `canManage`). A user with no membership gets 404, not 403, so a
 * repository's existence doesn't leak across organizations.
 *
 * Long-lived consumers (log streams) re-check through the same function, so a
 * removed member stops receiving lines.
 * @module shared/access
 */
import type { Queryable } from './db.js'
import { notFound, HttpError } from './errors.js'
import type { SessionUser } from './auth.js'

export type RepoRole = 'maintainer' | 'read'

export async function repoRole(db: Queryable, user: SessionUser, repoId: string): Promise<RepoRole | null> {
  const { rows } = await db.query<{ role: RepoRole }>('SELECT role FROM repo_members WHERE repo_id = $1 AND user_id = $2', [repoId, user.id])
  if (rows[0]) return rows[0].role
  if (user.isAdmin) {
    const exists = await db.query('SELECT 1 FROM repositories WHERE id = $1', [repoId])
    return exists.rows.length > 0 ? 'read' : null
  }
  return null
}

export async function requireRepoRead(db: Queryable, user: SessionUser, repoId: string): Promise<RepoRole> {
  const role = await repoRole(db, user, repoId)
  if (!role) throw notFound('Repository')
  return role
}

/** Mutations: re-run, cancel, approve, resolve, secrets, environments, fixtures. */
export async function requireRepoMaintainer(db: Queryable, user: SessionUser, repoId: string): Promise<void> {
  const role = await requireRepoRead(db, user, repoId)
  if (role !== 'maintainer') throw new HttpError(403, 'FORBIDDEN', 'You have read-only access to this repository')
}

export async function readableRepoIds(db: Queryable, user: SessionUser): Promise<string[]> {
  const { rows } = user.isAdmin
    ? await db.query<{ id: string }>('SELECT id FROM repositories')
    : await db.query<{ id: string }>('SELECT repo_id AS id FROM repo_members WHERE user_id = $1', [user.id])
  return rows.map((r) => r.id)
}
