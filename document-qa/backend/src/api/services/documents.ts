/**
 * Document reads: the library list, document detail and recently deleted.
 * Every query applies the live access rule (readableSql); a tombstoned
 * document is gone from all of them the moment the tombstone commits.
 * @module api/services/documents
 */
import { readableSql } from '../../shared/access.js'
import { pool, type Queryable } from '../../shared/db.js'
import { notFound } from '../../shared/errors.js'
import { PURGE_ORDER } from '../../pipeline/stages.js'
import { documentDto, jobDto, versionDto, type DocumentRow, type PurgeState, type StageState } from './dto.js'

const DOC_SELECT = `
  SELECT d.*, u.display_name AS owner_name, g.name AS group_name,
         lv.status AS latest_status, lv.failure_reason AS latest_failure, lv.filename AS latest_filename, lv.size_bytes AS latest_size,
         cv.chunk_count,
         (SELECT count(*)::int FROM index_entries e WHERE e.document_id = d.id AND e.acl_epoch < d.acl_epoch) AS stale_index_rows
    FROM documents d
    JOIN users u ON u.id = d.owner_id
    LEFT JOIN groups g ON g.id = d.group_id
    LEFT JOIN document_versions lv ON lv.document_id = d.id AND lv.version_no = d.latest_version_no
    LEFT JOIN document_versions cv ON cv.id = d.current_version_id`

/** Pipeline stage state for each document's latest version. */
async function stagesFor(db: Queryable, docIds: string[]): Promise<Map<string, StageState[]>> {
  const out = new Map<string, StageState[]>()
  if (docIds.length === 0) return out
  const { rows } = await db.query<{
    document_id: string
    stage: string
    status: string
    attempts: number
    max_attempts: number
    progress: Record<string, unknown>
    last_error: string | null
  }>(
    `SELECT j.document_id, j.stage, j.status, j.attempts, j.max_attempts, j.progress, j.last_error
       FROM processing_jobs j
       JOIN documents d ON d.id = j.document_id
       JOIN document_versions v ON v.id = j.version_id AND v.version_no = d.latest_version_no
      WHERE j.document_id = ANY($1) AND j.stage IN ('extract', 'chunk', 'embed', 'index')`,
    [docIds],
  )
  const order = ['extract', 'chunk', 'embed', 'index']
  for (const r of rows) {
    const list = out.get(r.document_id) ?? []
    list.push({ stage: r.stage, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, progress: r.progress, lastError: r.last_error })
    out.set(r.document_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))
  return out
}

export async function purgeStateFor(db: Queryable, docIds: string[]): Promise<Map<string, PurgeState>> {
  const out = new Map<string, PurgeState>()
  if (docIds.length === 0) return out
  const { rows } = await db.query<{
    document_id: string
    artifact: string
    status: string
    removed: number
    attempts: number
    last_error: string | null
    completed_at: Date | null
    purge_completed_at: Date | null
  }>(
    `SELECT p.*, d.purge_completed_at FROM purge_tasks p JOIN documents d ON d.id = p.document_id WHERE p.document_id = ANY($1)`,
    [docIds],
  )
  for (const r of rows) {
    const s = out.get(r.document_id) ?? { done: 0, total: 0, completedAt: r.purge_completed_at ? r.purge_completed_at.toISOString() : null, lastError: null, artifacts: [] }
    s.total += 1
    if (r.status === 'done') s.done += 1
    if (r.last_error && r.status !== 'done') s.lastError = `${r.artifact}: ${r.last_error}`
    s.artifacts.push({
      artifact: r.artifact,
      status: r.status,
      removed: r.removed,
      attempts: r.attempts,
      lastError: r.last_error,
      completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    })
    out.set(r.document_id, s)
  }
  for (const s of out.values()) s.artifacts.sort((a, b) => PURGE_ORDER.indexOf(a.artifact as never) - PURGE_ORDER.indexOf(b.artifact as never))
  return out
}

export async function listDocuments(orgId: string, userId: string) {
  const { rows } = await pool.query<DocumentRow>(`${DOC_SELECT} WHERE ${readableSql('d', '$1', '$2')} ORDER BY d.created_at DESC LIMIT 200`, [orgId, userId])
  const stages = await stagesFor(
    pool,
    rows.map((r) => r.id),
  )
  return rows.map((r) => documentDto(r, userId, stages.get(r.id) ?? []))
}

/** The caller's own deleted documents, with purge progress (titles only: the content is gone). */
export async function listDeleted(orgId: string, userId: string) {
  const { rows } = await pool.query<DocumentRow>(
    `${DOC_SELECT} WHERE d.org_id = $1 AND d.owner_id = $2 AND d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC LIMIT 20`,
    [orgId, userId],
  )
  const purge = await purgeStateFor(
    pool,
    rows.map((r) => r.id),
  )
  return rows.map((r) => {
    const dto = documentDto(r, userId, [], purge.get(r.id) ?? null)
    return { id: dto.id, title: dto.title, deletedAt: dto.deletedAt, purgeCompletedAt: dto.purgeCompletedAt, purge: dto.purge }
  })
}

export async function getReadableDocument(db: Queryable, orgId: string, userId: string, documentId: string) {
  const { rows } = await db.query<DocumentRow>(`${DOC_SELECT} WHERE d.id = $3 AND ${readableSql('d', '$1', '$2')}`, [orgId, userId, documentId])
  if (!rows[0]) throw notFound('Document')
  const stages = await stagesFor(db, [documentId])
  return documentDto(rows[0], userId, stages.get(documentId) ?? [])
}

export async function documentDetail(orgId: string, userId: string, documentId: string) {
  const document = await getReadableDocument(pool, orgId, userId, documentId)
  const [versions, jobs, attempts, events] = await Promise.all([
    pool.query(
      `SELECT v.*, (SELECT count(*)::int FROM chunks c WHERE c.version_id = v.id) AS live_chunks
         FROM document_versions v WHERE v.document_id = $1 ORDER BY v.version_no DESC`,
      [documentId],
    ),
    pool.query(`SELECT * FROM processing_jobs WHERE document_id = $1 ORDER BY created_at`, [documentId]),
    pool.query(
      `SELECT a.* FROM job_attempts a JOIN processing_jobs j ON j.id = a.job_id WHERE j.document_id = $1 ORDER BY a.started_at`,
      [documentId],
    ),
    pool.query<{ id: string; kind: string; detail: Record<string, unknown>; created_at: Date; actor: string | null }>(
      `SELECT e.id, e.kind, e.detail, e.created_at, u.display_name AS actor FROM document_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.document_id = $1 ORDER BY e.id DESC LIMIT 50`,
      [documentId],
    ),
  ])
  const byJob = new Map<string, typeof attempts.rows>()
  for (const a of attempts.rows) byJob.set(a.job_id, [...(byJob.get(a.job_id) ?? []), a])
  return {
    document,
    versions: versions.rows.map(versionDto),
    jobs: jobs.rows.map((j) => jobDto(j, byJob.get(j.id) ?? [])),
    events: events.rows.map((e) => ({ id: Number(e.id), kind: e.kind, detail: e.detail, actor: e.actor, createdAt: e.created_at.toISOString() })),
  }
}

/** Extracted text of one version (default: current), for the citation highlight view. */
export async function documentText(orgId: string, userId: string, documentId: string, versionId?: string) {
  const document = await getReadableDocument(pool, orgId, userId, documentId)
  const { rows } = await pool.query<{ id: string; version_no: number; text: string | null; headings: unknown; status: string }>(
    `SELECT v.id, v.version_no, v.status, t.text, t.headings FROM document_versions v LEFT JOIN version_texts t ON t.version_id = v.id
      WHERE v.document_id = $1 AND v.id = COALESCE($2, (SELECT current_version_id FROM documents WHERE id = $1), v.id)
      ORDER BY v.version_no DESC LIMIT 1`,
    [documentId, versionId ?? null],
  )
  if (!rows[0]) throw notFound('Version')
  return { document, versionId: rows[0].id, versionNo: rows[0].version_no, versionStatus: rows[0].status, text: rows[0].text, headings: rows[0].headings ?? [] }
}

export async function documentChunks(orgId: string, userId: string, documentId: string, versionId?: string) {
  await getReadableDocument(pool, orgId, userId, documentId)
  const { rows } = await pool.query<{
    id: string
    version_id: string
    ordinal: number
    text: string
    char_start: number
    char_end: number
    heading: string | null
    token_count: number
    embedded: boolean
    indexed: boolean
  }>(
    `SELECT c.id, c.version_id, c.ordinal, c.text, c.char_start, c.char_end, c.heading, c.token_count,
            EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id) AS embedded,
            EXISTS (SELECT 1 FROM index_entries i WHERE i.chunk_id = c.id) AS indexed
       FROM chunks c
      WHERE c.document_id = $1 AND c.version_id = COALESCE($2, (SELECT COALESCE(current_version_id, (SELECT id FROM document_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1)) FROM documents WHERE id = $1))
      ORDER BY c.ordinal`,
    [documentId, versionId ?? null],
  )
  return rows.map((r) => ({
    id: r.id,
    versionId: r.version_id,
    ordinal: r.ordinal,
    text: r.text,
    charStart: r.char_start,
    charEnd: r.char_end,
    heading: r.heading,
    tokenCount: r.token_count,
    embedded: r.embedded,
    indexed: r.indexed,
  }))
}
