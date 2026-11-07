/**
 * Stage handlers. Each is safe to run more than once for the same job:
 *
 * - extract   blob → normalized text (upsert by version)
 * - chunk     text → chunks (upsert by version + ordinal; chaos: exit halfway)
 * - embed     chunks without embeddings → vectors (upsert by chunk id)
 * - index     embeddings + current access metadata → index entries (upsert by
 *             chunk id), then switch the document's current version atomically
 * - retire    remove a superseded version's index entries, embeddings, chunks
 * - sync_acl  copy the document's scope/group/epoch onto its index entries
 * - purge     remove a deleted document's cache entries, index entries,
 *             embeddings, chunks and blobs, tracking each artifact
 *
 * A handler returns what should happen next; the worker commits the stage's
 * final writes, the job completion and the next job in one transaction.
 * @module pipeline/stages
 */
import type pg from 'pg'
import { maybeBlobOutage, consumeArmed, readSwitch } from '../shared/chaos.js'
import { config } from '../shared/config.js'
import { keys, redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { describeError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { deleteBlobs, getBlob } from '../shared/storage.js'
import { chunkText } from './chunk.js'
import { embedBatch } from './embed-client.js'
import { extract, kindOf, PermanentError, unsupportedReason, type Heading } from './extract.js'
import { enqueueJob, setProgress, heartbeat, type ClaimedJob, type EnqueueSpec, type Stage } from './jobs.js'
import { decideActivation, embedMissing, writeChunks } from './stage-core.js'
import { pgChunkWriter, pgEmbedStore } from './store.js'

export class LeaseLostError extends Error {}

export interface StageContext {
  job: ClaimedJob
  workerId: string
  /** Extends the lease; throws LeaseLostError when another worker has taken over. */
  keepAlive(): Promise<void>
  progress(p: Record<string, unknown>): Promise<void>
}

export type StageOutcome =
  | { kind: 'done'; next?: EnqueueSpec[]; detail?: Record<string, unknown>; finalize?: (client: pg.PoolClient) => Promise<string[] | void> }
  | { kind: 'defer'; delayMs: number; reason: string }
  | { kind: 'cancelled'; reason: string }

interface VersionRow {
  id: string
  document_id: string
  org_id: string
  version_no: number
  content_hash: string
  blob_key: string
  filename: string
  deleted_at: Date | null
}

async function loadVersion(versionId: string): Promise<VersionRow> {
  const { rows } = await pool.query<VersionRow>(
    `SELECT v.id, v.document_id, v.org_id, v.version_no, v.content_hash, v.blob_key, v.filename, d.deleted_at
       FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  )
  if (!rows[0]) throw new PermanentError(`version ${versionId} not found`)
  return rows[0]
}

const next = (v: VersionRow, stage: Stage): EnqueueSpec => ({ documentId: v.document_id, versionId: v.id, orgId: v.org_id, stage })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function extractStage(ctx: StageContext): Promise<StageOutcome> {
  const v = await loadVersion(ctx.job.version_id as string)
  if (v.deleted_at) return { kind: 'cancelled', reason: 'document deleted' }
  await pool.query(`UPDATE document_versions SET status = 'processing' WHERE id = $1 AND status IN ('uploaded', 'failed')`, [v.id])
  await pool.query(
    `UPDATE documents SET status = 'processing', failure_reason = NULL, updated_at = now()
      WHERE id = $1 AND current_version_id IS NULL AND status <> 'processing'`,
    [v.document_id],
  )
  const kind = kindOf(v.filename)
  if (!kind) throw new PermanentError(unsupportedReason(v.filename))
  await maybeBlobOutage()
  const bytes = await getBlob(v.blob_key)
  const extracted = extract(bytes, kind)
  await pool.query(
    `INSERT INTO version_texts (version_id, text, headings) VALUES ($1, $2, $3)
     ON CONFLICT (version_id) DO UPDATE SET text = EXCLUDED.text, headings = EXCLUDED.headings`,
    [v.id, extracted.text, JSON.stringify(extracted.headings)],
  )
  await pool.query(`UPDATE document_versions SET char_count = $2 WHERE id = $1`, [v.id, extracted.text.length])
  return { kind: 'done', next: [next(v, 'chunk')], detail: { chars: extracted.text.length, headings: extracted.headings.length, kind } }
}

async function chunkStage(ctx: StageContext): Promise<StageOutcome> {
  const v = await loadVersion(ctx.job.version_id as string)
  if (v.deleted_at) return { kind: 'cancelled', reason: 'document deleted' }
  const { rows } = await pool.query<{ text: string; headings: Heading[] }>(`SELECT text, headings FROM version_texts WHERE version_id = $1`, [v.id])
  if (!rows[0]) throw new Error('extracted text missing; extract must run first')
  const specs = chunkText(rows[0].text, rows[0].headings, { targetTokens: config.pipeline.chunkTokens, overlapTokens: config.pipeline.chunkOverlapTokens })
  let killChecked = false
  const result = await writeChunks(pgChunkWriter(v.document_id, v.org_id), v.id, specs, config.pipeline.chunkWriteBatch, async (written, total) => {
    await ctx.progress({ done: written, total })
    await ctx.keepAlive()
    if (!killChecked && written * 2 >= total && written < total) {
      killChecked = true
      if (await consumeArmed('kill_mid_chunk')) {
        await pool.query(`UPDATE job_attempts SET detail = $2 WHERE id = $1`, [ctx.job.attemptId, { chunksWrittenBeforeExit: written, total }])
        logger.error({ jobId: ctx.job.id, written, total }, 'chaos kill_mid_chunk: exiting the worker process mid-stage')
        process.exit(1)
      }
    }
  })
  await pool.query(`UPDATE document_versions SET chunk_count = $2 WHERE id = $1`, [v.id, specs.length])
  return { kind: 'done', next: [next(v, 'embed')], detail: { chunks: specs.length, trimmed: result.trimmed } }
}

async function embedStage(ctx: StageContext): Promise<StageOutcome> {
  const v = await loadVersion(ctx.job.version_id as string)
  if (v.deleted_at) return { kind: 'cancelled', reason: 'document deleted' }
  const { rows } = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM chunks WHERE version_id = $1`, [v.id])
  const total = rows[0]?.total ?? 0
  let rateLimited = 0
  const result = await embedMissing(
    pgEmbedStore(),
    v.id,
    config.pipeline.embedBatch,
    async (inputs) => {
      const r = await embedBatch(inputs, {
        onWait: async (ms, attempt) => {
          await ctx.progress({ ...(ctx.job.progress ?? {}), waiting: `rate limited; retry ${attempt} in ${ms} ms` })
          await ctx.keepAlive()
        },
      })
      rateLimited += r.rateLimitedRetries
      return r
    },
    async (embeddedNow, missingAtStart) => {
      await ctx.progress({ done: total - missingAtStart + embeddedNow, total })
      await ctx.keepAlive()
    },
  )
  return { kind: 'done', next: [next(v, 'index')], detail: { embedded: result.embedded, alreadyEmbedded: total - result.embedded, rateLimitedRetries: rateLimited } }
}

async function indexStage(ctx: StageContext): Promise<StageOutcome> {
  const v = await loadVersion(ctx.job.version_id as string)
  if (v.deleted_at) return { kind: 'cancelled', reason: 'document deleted' }
  const { rowCount } = await pool.query(
    `INSERT INTO index_entries (chunk_id, org_id, document_id, version_id, owner_id, scope, group_id, acl_epoch, embedding)
     SELECT c.id, d.org_id, d.id, c.version_id, d.owner_id, d.scope, d.group_id, d.acl_epoch, e.embedding
       FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id JOIN documents d ON d.id = c.document_id
      WHERE c.version_id = $1
     ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding, owner_id = EXCLUDED.owner_id, scope = EXCLUDED.scope,
       group_id = EXCLUDED.group_id, acl_epoch = EXCLUDED.acl_epoch, synced_at = now()`,
    [v.id],
  )
  const { rows } = await pool.query<{ chunks: number; entries: number }>(
    `SELECT (SELECT count(*)::int FROM chunks WHERE version_id = $1) AS chunks, (SELECT count(*)::int FROM index_entries WHERE version_id = $1) AS entries`,
    [v.id],
  )
  if (rows[0].entries !== rows[0].chunks) throw new Error(`index incomplete: ${rows[0].entries}/${rows[0].chunks} entries`)
  await ctx.progress({ done: rows[0].entries, total: rows[0].chunks })

  // Chaos: hold the new version in the index, not yet current, so the demo can ask questions during the overlap.
  const hold = await readSwitch('activation_delay_ms')
  for (let waited = 0; waited < hold; waited += 1000) {
    await ctx.progress({ done: rows[0].entries, total: rows[0].chunks, waiting: `activation held for ${Math.ceil((hold - waited) / 1000)} s` })
    await ctx.keepAlive()
    await sleep(Math.min(1000, hold - waited))
  }

  return {
    kind: 'done',
    detail: { indexed: rowCount ?? 0 },
    finalize: async (client) => {
      const { rows: docs } = await client.query<{ deleted_at: Date | null; current_version_no: number | null; current_version_id: string | null }>(
        `SELECT deleted_at, current_version_no, current_version_id FROM documents WHERE id = $1 FOR UPDATE`,
        [v.document_id],
      )
      const doc = docs[0]
      const decision = decideActivation({ deletedAt: doc.deleted_at, currentVersionNo: doc.current_version_no }, v.version_no)
      const publish: string[] = []
      if (decision === 'document_deleted') {
        await client.query(`UPDATE document_versions SET status = 'cancelled' WHERE id = $1`, [v.id])
        return publish
      }
      if (decision === 'stale') {
        // An even newer version became current first: this one is never served.
        await client.query(`UPDATE document_versions SET status = 'superseded', ready_at = now(), superseded_at = now() WHERE id = $1`, [v.id])
        await enqueueJob(client, { ...next(v, 'retire'), delayMs: config.pipeline.retireDelayMs })
        return publish
      }
      // The switch: one row update. Every retrieval snapshot sees either the old pointer or the new one.
      await client.query(
        `UPDATE documents SET current_version_id = $2, current_version_no = $3, content_hash = $4, status = 'ready', failure_reason = NULL, updated_at = now()
          WHERE id = $1`,
        [v.document_id, v.id, v.version_no, v.content_hash],
      )
      await client.query(`UPDATE document_versions SET status = 'ready', ready_at = now(), activated_at = now() WHERE id = $1`, [v.id])
      if (doc.current_version_id) {
        await client.query(`UPDATE document_versions SET status = 'superseded', superseded_at = now() WHERE id = $1`, [doc.current_version_id])
        await enqueueJob(client, { documentId: v.document_id, versionId: doc.current_version_id, orgId: v.org_id, stage: 'retire', delayMs: config.pipeline.retireDelayMs })
      }
      await client.query(`INSERT INTO document_events (document_id, kind, detail) VALUES ($1, 'version_activated', $2)`, [
        v.document_id,
        { versionNo: v.version_no, previousVersionNo: doc.current_version_no },
      ])
      return publish
    },
  }
}

async function retireStage(ctx: StageContext): Promise<StageOutcome> {
  const versionId = ctx.job.version_id as string
  const { rows } = await pool.query<{ current_version_id: string | null }>(`SELECT current_version_id FROM documents WHERE id = $1`, [ctx.job.document_id])
  if (rows[0]?.current_version_id === versionId) return { kind: 'done', detail: { skipped: 'version is current' } }
  const ids = `SELECT id FROM chunks WHERE version_id = $1`
  const index = await pool.query(`DELETE FROM index_entries WHERE version_id = $1`, [versionId])
  const embeddings = await pool.query(`DELETE FROM chunk_embeddings WHERE chunk_id IN (${ids})`, [versionId])
  const chunks = await pool.query(`DELETE FROM chunks WHERE version_id = $1`, [versionId])
  return {
    kind: 'done',
    detail: { index: index.rowCount, embeddings: embeddings.rowCount, chunks: chunks.rowCount },
    finalize: async (client) => {
      await client.query(`UPDATE document_versions SET status = 'retired', retired_at = now() WHERE id = $1 AND status = 'superseded'`, [versionId])
    },
  }
}

async function syncAclStage(ctx: StageContext): Promise<StageOutcome> {
  if ((await readSwitch('acl_sync_paused')) > 0) return { kind: 'defer', delayMs: 2000, reason: 'index metadata sync paused (ops switch)' }
  const { rowCount } = await pool.query(
    `UPDATE index_entries e SET owner_id = d.owner_id, scope = d.scope, group_id = d.group_id, acl_epoch = d.acl_epoch, synced_at = now()
       FROM documents d
      WHERE e.document_id = d.id AND d.id = $1 AND d.deleted_at IS NULL AND e.acl_epoch < d.acl_epoch`,
    [ctx.job.document_id],
  )
  return { kind: 'done', detail: { entriesUpdated: rowCount ?? 0 } }
}

export const PURGE_ORDER = ['cache', 'index', 'embeddings', 'chunks', 'blobs'] as const
export type PurgeArtifact = (typeof PURGE_ORDER)[number]

async function purgeArtifact(documentId: string, artifact: PurgeArtifact): Promise<number> {
  switch (artifact) {
    case 'cache': {
      const setKey = keys.answersByDoc(documentId)
      const members = await redis.smembers(setKey)
      const removed = members.length > 0 ? await redis.del(...members) : 0
      await redis.del(setKey)
      // Persisted answers are derived content too: scrub any whose prompt included this document.
      const scrubbed = await pool.query(
        `UPDATE answer_runs SET output_text = '', sources = '[]', citations = '[]',
           cache = cache || jsonb_build_object('scrubbed', 'a source document was deleted and purged')
         WHERE sources @> $1::jsonb`,
        [JSON.stringify([{ documentId }])],
      )
      return removed + (scrubbed.rowCount ?? 0)
    }
    case 'index':
      return (await pool.query(`DELETE FROM index_entries WHERE document_id = $1`, [documentId])).rowCount ?? 0
    case 'embeddings':
      return (await pool.query(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = $1)`, [documentId])).rowCount ?? 0
    case 'chunks': {
      const removed = (await pool.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId])).rowCount ?? 0
      await pool.query(`DELETE FROM version_texts WHERE version_id IN (SELECT id FROM document_versions WHERE document_id = $1)`, [documentId])
      return removed
    }
    case 'blobs': {
      await maybeBlobOutage()
      const { rows } = await pool.query<{ blob_key: string }>(`SELECT blob_key FROM document_versions WHERE document_id = $1`, [documentId])
      return deleteBlobs(rows.map((r) => r.blob_key))
    }
  }
}

async function purgeStage(ctx: StageContext): Promise<StageOutcome> {
  const documentId = ctx.job.document_id
  if ((await readSwitch('purge_paused')) > 0) return { kind: 'defer', delayMs: 2000, reason: 'purge paused (ops switch, like a legal hold)' }
  // Never purge underneath a stage that is still writing: wait for it to stop (it will find the tombstone and cancel).
  const { rows: busy } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM processing_jobs
      WHERE document_id = $1 AND stage <> 'purge' AND status = 'running' AND lease_expires_at > now()`,
    [documentId],
  )
  if (busy[0].n > 0) return { kind: 'defer', delayMs: 1500, reason: `waiting for ${busy[0].n} in-flight stage(s) to stop` }

  const { rows: tasks } = await pool.query<{ artifact: PurgeArtifact; status: string }>(`SELECT artifact, status FROM purge_tasks WHERE document_id = $1`, [documentId])
  const pending = new Set(tasks.filter((t) => t.status === 'pending').map((t) => t.artifact))
  let done = tasks.length - pending.size
  for (const artifact of PURGE_ORDER) {
    if (!pending.has(artifact)) continue
    try {
      const removed = await purgeArtifact(documentId, artifact)
      await pool.query(
        `UPDATE purge_tasks SET status = 'done', removed = $3, attempts = attempts + 1, last_error = NULL, completed_at = now()
          WHERE document_id = $1 AND artifact = $2`,
        [documentId, artifact, removed],
      )
      done += 1
      await ctx.progress({ done, total: PURGE_ORDER.length })
    } catch (err) {
      await pool.query(`UPDATE purge_tasks SET attempts = attempts + 1, last_error = $3 WHERE document_id = $1 AND artifact = $2`, [
        documentId,
        artifact,
        describeError(err),
      ])
      throw new Error(`purge ${artifact}: ${describeError(err)}`, { cause: err })
    }
  }
  // Verify nothing was written back after its artifact was purged (a stage racing the tombstone).
  const { rows: left } = await pool.query<{ index: number; embeddings: number; chunks: number }>(
    `SELECT (SELECT count(*)::int FROM index_entries WHERE document_id = $1) AS index,
            (SELECT count(*)::int FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = $1) AS embeddings,
            (SELECT count(*)::int FROM chunks WHERE document_id = $1) AS chunks`,
    [documentId],
  )
  const stragglers = (Object.entries(left[0]) as [PurgeArtifact, number][]).filter(([, n]) => n > 0).map(([a]) => a)
  if (stragglers.length > 0) {
    await pool.query(`UPDATE purge_tasks SET status = 'pending', completed_at = NULL WHERE document_id = $1 AND artifact = ANY($2)`, [documentId, stragglers])
    throw new Error(`late writes found after purge (${stragglers.join(', ')}); purging again`)
  }
  return {
    kind: 'done',
    detail: { artifacts: PURGE_ORDER.length },
    finalize: async (client) => {
      await client.query(`UPDATE documents SET purge_completed_at = now() WHERE id = $1 AND purge_completed_at IS NULL`, [documentId])
      await client.query(`INSERT INTO document_events (document_id, kind, detail) VALUES ($1, 'purged', '{}')`, [documentId])
    },
  }
}

export const handlers: Record<Stage, (ctx: StageContext) => Promise<StageOutcome>> = {
  extract: extractStage,
  chunk: chunkStage,
  embed: embedStage,
  index: indexStage,
  retire: retireStage,
  sync_acl: syncAclStage,
  purge: purgeStage,
}

export function makeContext(job: ClaimedJob, workerId: string, onLost: () => void): StageContext {
  let lost = false
  return {
    job,
    workerId,
    async keepAlive() {
      if (lost || !(await heartbeat(job))) {
        lost = true
        onLost()
        throw new LeaseLostError(`lease on ${job.id} was taken over`)
      }
    },
    async progress(p) {
      job.progress = p
      await setProgress(job, p)
    },
  }
}
