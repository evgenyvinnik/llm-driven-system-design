/**
 * Moves finished logs out of PostgreSQL into MinIO. Object first, then the database
 * transaction that points at it and deletes the rows: a crash in between leaves both
 * copies, and the next sweep overwrites the same key with the same bytes. If MinIO is
 * down, logs simply stay in PostgreSQL and keep being served from there.
 * @module logs/archive
 */
import { pool, withTransaction } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { logArchiveKey, putBlob } from '../shared/storage.js'

export async function archiveClosedStreams(limit = 20): Promise<number> {
  const { rows } = await pool.query<{ job_id: string; attempt: number; repo_id: string; run_id: string }>(
    `SELECT s.job_id, s.attempt, j.repo_id, j.run_id FROM log_streams s JOIN jobs j ON j.id = s.job_id
      WHERE s.closed_at IS NOT NULL AND s.archived_at IS NULL ORDER BY s.closed_at LIMIT $1`,
    [limit],
  )
  let archived = 0
  for (const row of rows) {
    try {
      const lines = await pool.query<{ line_no: number; step_index: number; text: string; at: Date }>('SELECT line_no, step_index, text, at FROM log_lines WHERE job_id = $1 AND attempt = $2 ORDER BY line_no', [row.job_id, row.attempt])
      const body = lines.rows.map((l) => JSON.stringify({ n: l.line_no, step: l.step_index, text: l.text, at: l.at.toISOString() })).join('\n')
      const key = logArchiveKey(row.repo_id, row.run_id, row.job_id, row.attempt)
      await putBlob(key, Buffer.from(body, 'utf8'), 'application/x-ndjson')
      await withTransaction(async (client) => {
        const updated = await client.query(`UPDATE log_streams SET archived_key = $3, archived_at = now(), mask_enc = NULL WHERE job_id = $1 AND attempt = $2 AND archived_at IS NULL`, [row.job_id, row.attempt, key])
        if (!updated.rowCount) return
        await client.query('DELETE FROM log_lines WHERE job_id = $1 AND attempt = $2', [row.job_id, row.attempt])
        await client.query('DELETE FROM log_chunks WHERE job_id = $1 AND attempt = $2', [row.job_id, row.attempt])
      })
      archived++
    } catch (err) {
      logger.warn({ err: (err as Error).message, code: (err as { code?: string }).code, jobId: row.job_id, attempt: row.attempt }, 'log archive failed; will retry, and the log stays readable from PostgreSQL')
    }
  }
  return archived
}
