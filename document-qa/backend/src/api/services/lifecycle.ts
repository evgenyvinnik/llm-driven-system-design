/**
 * Access and lifecycle changes: sharing, delete (tombstone first, then a
 * tracked purge) and retrying a failed document.
 *
 * A sharing change commits the new scope and bumps the document's
 * acl_epoch; the index rows' copy of the scope is updated later by a
 * `sync_acl` job. Until then the index is stale, which is fine: a revoke is
 * enforced by the re-check on the next question, and a grant shows up once
 * the sync lands (seconds).
 * @module api/services/lifecycle
 */
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { withTransaction } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { enqueueJob, retryPoisoned } from '../../pipeline/jobs.js'
import { PURGE_ORDER } from '../../pipeline/stages.js'
import { getReadableDocument } from './documents.js'

export const sharingSchema = z
  .object({ scope: z.enum(['private', 'group', 'org']), groupId: z.string().nullable().optional() })
  .refine((v) => (v.scope === 'group') === Boolean(v.groupId), { message: 'groupId is required for group scope (and only for it)' })

async function lockOwned(client: import('pg').PoolClient, orgId: string, userId: string, documentId: string) {
  const { rows } = await client.query<{ id: string; owner_id: string; scope: string; group_id: string | null; deleted_at: Date | null; title: string }>(
    `SELECT id, owner_id, scope, group_id, deleted_at, title FROM documents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [documentId, orgId],
  )
  const doc = rows[0]
  if (!doc || doc.deleted_at) throw notFound('Document')
  if (doc.owner_id !== userId) throw new HttpError(403, 'NOT_OWNER', 'Only the owner can change this document')
  return doc
}

export async function changeSharing(orgId: string, userId: string, documentId: string, input: z.infer<typeof sharingSchema>) {
  return withTransaction(async (client) => {
    const doc = await lockOwned(client, orgId, userId, documentId)
    const groupId = input.scope === 'group' ? (input.groupId as string) : null
    if (groupId) {
      const { rows } = await client.query(`SELECT 1 FROM groups WHERE id = $1 AND org_id = $2`, [groupId, orgId])
      if (!rows[0]) throw new HttpError(422, 'UNKNOWN_GROUP', 'That group is not in your organization')
    }
    if (doc.scope === input.scope && doc.group_id === groupId) {
      return { document: await getReadableDocument(client, orgId, userId, documentId), changed: false }
    }
    await client.query(`UPDATE documents SET scope = $2, group_id = $3, acl_epoch = acl_epoch + 1, updated_at = now() WHERE id = $1`, [documentId, input.scope, groupId])
    await enqueueJob(client, { documentId, versionId: null, orgId, stage: 'sync_acl', delayMs: config.pipeline.aclSyncDelayMs, rearm: true })
    await client.query(`INSERT INTO document_events (document_id, actor_id, kind, detail) VALUES ($1, $2, 'sharing_changed', $3)`, [
      documentId,
      userId,
      { from: { scope: doc.scope, groupId: doc.group_id }, to: { scope: input.scope, groupId } },
    ])
    return { document: await getReadableDocument(client, orgId, userId, documentId), changed: true }
  })
}

/**
 * Tombstone first: one transaction sets deleted_at (every read path filters
 * on it, so the document is gone from the library, retrieval and cached
 * answers at commit), cancels its pending pipeline jobs, creates one
 * purge_tasks row per artifact and enqueues the purge job.
 */
export async function deleteDocument(orgId: string, userId: string, documentId: string) {
  return withTransaction(async (client) => {
    const doc = await lockOwned(client, orgId, userId, documentId)
    const { rows } = await client.query<{ deleted_at: Date }>(
      `UPDATE documents SET deleted_at = now(), deleted_by = $2, acl_epoch = acl_epoch + 1, updated_at = now() WHERE id = $1 RETURNING deleted_at`,
      [documentId, userId],
    )
    await client.query(
      `UPDATE processing_jobs SET status = 'cancelled', finished_at = now(), last_error = 'document deleted', updated_at = now()
        WHERE document_id = $1 AND status = 'pending' AND stage <> 'purge'`,
      [documentId],
    )
    await client.query(
      `INSERT INTO purge_tasks (document_id, artifact) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [documentId, [...PURGE_ORDER]],
    )
    const jobId = await enqueueJob(client, { documentId, versionId: null, orgId, stage: 'purge' })
    await client.query(`INSERT INTO document_events (document_id, actor_id, kind, detail) VALUES ($1, $2, 'deleted', $3)`, [documentId, userId, { title: doc.title }])
    return { id: documentId, title: doc.title, deletedAt: rows[0].deleted_at.toISOString(), jobIds: jobId ? [jobId] : [] }
  })
}

/** Owner retry of a failed (poisoned) pipeline stage on the latest version. */
export async function retryDocument(orgId: string, userId: string, documentId: string) {
  return withTransaction(async (client) => {
    await lockOwned(client, orgId, userId, documentId)
    const { rows } = await client.query<{ id: string; version_id: string }>(
      `SELECT j.id, j.version_id FROM processing_jobs j JOIN documents d ON d.id = j.document_id
         JOIN document_versions v ON v.id = j.version_id AND v.version_no = d.latest_version_no
        WHERE j.document_id = $1 AND j.status = 'poisoned' AND j.stage IN ('extract', 'chunk', 'embed', 'index')`,
      [documentId],
    )
    if (rows.length === 0) throw new HttpError(409, 'NOTHING_TO_RETRY', 'No failed stage to retry')
    const jobIds: string[] = []
    for (const r of rows) {
      const id = await retryPoisoned(client, r.id)
      if (id) jobIds.push(id)
      await client.query(`UPDATE document_versions SET status = 'processing', failure_reason = NULL WHERE id = $1`, [r.version_id])
    }
    await client.query(`UPDATE documents SET status = 'processing', failure_reason = NULL, updated_at = now() WHERE id = $1 AND current_version_id IS NULL`, [documentId])
    await client.query(`INSERT INTO document_events (document_id, actor_id, kind, detail) VALUES ($1, $2, 'retry_requested', $3)`, [documentId, userId, { jobs: rows.length }])
    return { document: await getReadableDocument(client, orgId, userId, documentId), jobIds }
  })
}
