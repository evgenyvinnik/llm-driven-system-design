/**
 * Secret storage. Values are encrypted on the way in and only ever decrypted in
 * the claim path. Nothing here returns a value: the DTOs are metadata only.
 * @module secrets/store
 */
import type { Queryable } from '../shared/db.js'
import { encrypt } from '../shared/crypto.js'
import { HttpError, notFound } from '../shared/errors.js'
import { newId } from '../shared/ids.js'

export function secretAad(repoId: string, environmentId: string | null, name: string): string {
  return `secret:${repoId}:${environmentId ?? ''}:${name}`
}

export interface SecretMeta {
  id: string
  name: string
  scope: 'repository' | 'environment'
  environment: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  lastReleasedAt: string | null
  releaseCount: number
}

async function environmentIdOf(db: Queryable, repoId: string, environment: string | null | undefined): Promise<string | null> {
  if (!environment) return null
  const { rows } = await db.query<{ id: string }>('SELECT id FROM environments WHERE repo_id = $1 AND name = $2', [repoId, environment])
  if (!rows[0]) throw new HttpError(422, 'UNKNOWN_ENVIRONMENT', `Environment "${environment}" does not exist`)
  return rows[0].id
}

/** Creates or rotates. Returns metadata: the value is never returned, here or anywhere else. */
export async function putSecret(db: Queryable, repoId: string, name: string, value: string, environment: string | null | undefined, actor: string): Promise<{ id: string; created: boolean }> {
  const environmentId = await environmentIdOf(db, repoId, environment)
  const ciphertext = encrypt(value, secretAad(repoId, environmentId, name))
  const { rows } = await db.query<{ id: string; created: boolean }>(
    `INSERT INTO secrets (id, repo_id, environment_id, name, ciphertext, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (repo_id, COALESCE(environment_id, ''), name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [newId('sec'), repoId, environmentId, name, ciphertext, actor],
  )
  return rows[0]
}

export async function deleteSecret(db: Queryable, repoId: string, secretId: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM secrets WHERE id = $1 AND repo_id = $2', [secretId, repoId])
  if (!rowCount) throw notFound('Secret')
}

export async function listSecrets(db: Queryable, repoId: string): Promise<SecretMeta[]> {
  const { rows } = await db.query<{ id: string; name: string; env_name: string | null; created_by: string; created_at: Date; updated_at: Date; last_released_at: Date | null; release_count: number }>(
    `SELECT s.id, s.name, e.name AS env_name, s.created_by, s.created_at, s.updated_at,
            (SELECT max(released_at) FROM secret_releases r WHERE r.secret_id = s.id) AS last_released_at,
            (SELECT count(*)::int FROM secret_releases r WHERE r.secret_id = s.id) AS release_count
       FROM secrets s LEFT JOIN environments e ON e.id = s.environment_id
      WHERE s.repo_id = $1 ORDER BY e.name NULLS FIRST, s.name`,
    [repoId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.env_name ? 'environment' : 'repository',
    environment: r.env_name,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    lastReleasedAt: r.last_released_at?.toISOString() ?? null,
    releaseCount: r.release_count,
  }))
}
