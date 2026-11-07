/**
 * Uploads: a new document, or a new version of one, with idempotency and
 * content-hash dedupe.
 *
 * Bytes come through the API (multipart). The API must hash them for dedupe
 * and validate the type before anything is stored; at this size (≤ 5 MB) that
 * is cheaper than a presigned PUT plus a second "commit" call. Production with
 * large files would switch to presigned PUTs with a client-declared SHA-256
 * that the extract stage verifies (architecture.md, Key Design Decisions).
 *
 * One transaction per upload:
 * 1. Advisory lock on (user, Idempotency-Key); a stored response is replayed
 *    (same key + different bytes → 422).
 * 2. New document: advisory lock on (org, content hash), then look for a live
 *    document in the org with the same bytes that the uploader can read →
 *    return it as a duplicate, creating nothing. A same-hash document the
 *    uploader can't read is ignored, so dedupe never reveals that it exists.
 *    New version: lock the document row; identical bytes → "unchanged".
 * 3. PUT the blob under a per-version key, insert document/version rows, the
 *    extract job and the idempotency record; commit; publish the ticket.
 *    A MinIO failure rolls everything back (503, safe to retry with the key).
 * @module api/services/uploads
 */
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { readableSql } from '../../shared/access.js'
import { withTransaction } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { logger } from '../../shared/logger.js'
import { uploads } from '../../shared/metrics.js'
import { blobKey, putBlob } from '../../shared/storage.js'
import { enqueueJob } from '../../pipeline/jobs.js'
import { extensionOf, kindOf, MIME_BY_KIND, unsupportedReason } from '../../pipeline/extract.js'
import { getReadableDocument } from './documents.js'

export interface UploadInput {
  orgId: string
  userId: string
  filename: string
  bytes: Buffer
  title?: string
  idempotencyKey?: string
  /** Set for a new version of an existing document. */
  documentId?: string
}

export interface UploadResult {
  status: number
  body: Record<string, unknown>
  replayed: boolean
  jobIds: string[]
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function titleFrom(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Untitled document'
}

async function remember(client: pg.PoolClient, input: UploadInput, requestHash: string, status: number, body: Record<string, unknown>): Promise<void> {
  if (!input.idempotencyKey) return
  await client.query(
    `INSERT INTO upload_requests (user_id, idempotency_key, request_hash, status_code, response) VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.idempotencyKey, requestHash, status, body],
  )
}

export async function upload(input: UploadInput): Promise<UploadResult> {
  const kind = kindOf(input.filename)
  if (!kind) {
    uploads.inc({ outcome: 'rejected' })
    throw new HttpError(415, 'UNSUPPORTED_TYPE', unsupportedReason(input.filename))
  }
  if (input.bytes.length === 0) {
    uploads.inc({ outcome: 'rejected' })
    throw new HttpError(422, 'EMPTY_FILE', 'The file is empty')
  }
  const contentHash = sha256(input.bytes)
  const requestHash = sha256(`${input.documentId ?? 'new'}:${contentHash}:${input.title ?? ''}`)

  return withTransaction(async (client) => {
    if (input.idempotencyKey) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`upload:${input.userId}:${input.idempotencyKey}`])
      const { rows } = await client.query<{ request_hash: string; status_code: number; response: Record<string, unknown> }>(
        `SELECT request_hash, status_code, response FROM upload_requests WHERE user_id = $1 AND idempotency_key = $2`,
        [input.userId, input.idempotencyKey],
      )
      if (rows[0]) {
        if (rows[0].request_hash !== requestHash) {
          throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different upload')
        }
        uploads.inc({ outcome: 'idempotent_replay' })
        return { status: rows[0].status_code, body: rows[0].response, replayed: true, jobIds: [] }
      }
    }

    let documentId: string
    let versionNo: number
    let title: string
    let isNewDocument: boolean
    if (!input.documentId) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hash:${input.orgId}:${contentHash}`])
      const { rows: dup } = await client.query<{ id: string }>(
        `SELECT d.id FROM documents d
           JOIN document_versions v ON v.document_id = d.id
          WHERE v.org_id = $1 AND v.content_hash = $3
            AND v.id = COALESCE(d.current_version_id, (SELECT id FROM document_versions WHERE document_id = d.id ORDER BY version_no DESC LIMIT 1))
            AND ${readableSql('d', '$1', '$2')}
          ORDER BY d.created_at LIMIT 1`,
        [input.orgId, input.userId, contentHash],
      )
      if (dup[0]) {
        const document = await getReadableDocument(client, input.orgId, input.userId, dup[0].id)
        const body = { duplicate: true, unchanged: false, document }
        await remember(client, input, requestHash, 200, body)
        uploads.inc({ outcome: 'duplicate' })
        return { status: 200, body, replayed: false, jobIds: [] }
      }
      documentId = newId.document()
      versionNo = 1
      title = (input.title?.trim() || titleFrom(input.filename)).slice(0, 200)
      isNewDocument = true
    } else {
      const { rows } = await client.query<{ id: string; owner_id: string; latest_version_no: number; deleted_at: Date | null; title: string; latest_hash: string | null }>(
        `SELECT d.id, d.owner_id, d.latest_version_no, d.deleted_at, d.title,
                (SELECT content_hash FROM document_versions WHERE document_id = d.id ORDER BY version_no DESC LIMIT 1) AS latest_hash
           FROM documents d WHERE d.id = $1 AND d.org_id = $2 FOR UPDATE`,
        [input.documentId, input.orgId],
      )
      const doc = rows[0]
      if (!doc || doc.deleted_at) throw notFound('Document')
      if (doc.owner_id !== input.userId) throw new HttpError(403, 'NOT_OWNER', 'Only the owner can upload a new version')
      if (doc.latest_hash === contentHash) {
        const document = await getReadableDocument(client, input.orgId, input.userId, doc.id)
        const body = { duplicate: false, unchanged: true, document }
        await remember(client, input, requestHash, 200, body)
        uploads.inc({ outcome: 'unchanged' })
        return { status: 200, body, replayed: false, jobIds: [] }
      }
      documentId = doc.id
      versionNo = doc.latest_version_no + 1
      title = doc.title
      isNewDocument = false
    }

    const versionId = newId.version()
    const key = blobKey(input.orgId, documentId, versionNo, contentHash, extensionOf(input.filename))
    try {
      await putBlob(key, input.bytes, MIME_BY_KIND[kind])
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'blob upload failed')
      throw new HttpError(503, 'BLOB_STORE_UNAVAILABLE', 'File storage is unavailable; retry with the same Idempotency-Key')
    }
    if (isNewDocument) {
      await client.query(
        `INSERT INTO documents (id, org_id, owner_id, title, status, latest_version_no, content_hash) VALUES ($1, $2, $3, $4, 'uploaded', 1, $5)`,
        [documentId, input.orgId, input.userId, title, contentHash],
      )
    } else {
      await client.query(`UPDATE documents SET latest_version_no = $2, updated_at = now() WHERE id = $1`, [documentId, versionNo])
    }
    await client.query(
      `INSERT INTO document_versions (id, document_id, org_id, version_no, content_hash, blob_key, filename, mime_type, size_bytes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [versionId, documentId, input.orgId, versionNo, contentHash, key, input.filename.slice(0, 255), MIME_BY_KIND[kind], input.bytes.length, input.userId],
    )
    const jobId = await enqueueJob(client, { documentId, versionId, orgId: input.orgId, stage: 'extract' })
    await client.query(`INSERT INTO document_events (document_id, actor_id, kind, detail) VALUES ($1, $2, $3, $4)`, [
      documentId,
      input.userId,
      isNewDocument ? 'uploaded' : 'version_uploaded',
      { versionNo, filename: input.filename, bytes: input.bytes.length },
    ])
    const document = await getReadableDocument(client, input.orgId, input.userId, documentId)
    const body = { duplicate: false, unchanged: false, document, versionId, versionNo }
    await remember(client, input, requestHash, 201, body)
    uploads.inc({ outcome: isNewDocument ? 'created' : 'new_version' })
    return { status: 201, body, replayed: false, jobIds: jobId ? [jobId] : [] }
  })
}
