/**
 * Deletes artifacts past their retention: the object first, then the row is marked, so a
 * crash in between leaves a marked-later row that the next sweep finishes. The row stays,
 * so the run's history still says the artifact existed.
 * @module scheduler/retention
 */
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { deleteBlob } from '../shared/storage.js'

export async function expireArtifacts(limit = 50): Promise<number> {
  const { rows } = await pool.query<{ id: string; object_key: string }>(`SELECT id, object_key FROM artifacts WHERE deleted_at IS NULL AND expires_at <= now() ORDER BY expires_at LIMIT $1`, [limit])
  let deleted = 0
  for (const row of rows) {
    try {
      await deleteBlob(row.object_key)
      await pool.query('UPDATE artifacts SET deleted_at = now() WHERE id = $1', [row.id])
      deleted++
    } catch (err) {
      logger.warn({ err: (err as Error).message, artifact: row.id }, 'artifact expiry failed; will retry')
    }
  }
  return deleted
}
