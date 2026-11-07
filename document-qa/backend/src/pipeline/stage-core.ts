/**
 * The storage-independent core of the stages that must be safe to redo.
 *
 * - `writeChunks` upserts chunk rows in small batches keyed by (version,
 *   ordinal), then trims ordinals past the end. Running it again after a crash
 *   at any batch rewrites the same rows: no duplicates, same ids.
 * - `embedMissing` embeds only chunks that have no embedding yet and upserts
 *   by chunk id, so a redo resumes where the crashed attempt stopped.
 * - `decideActivation` is the version-switch rule: a version becomes current
 *   only if the document is live and nothing newer is current already.
 *
 * Unit-tested against in-memory stores in stage-core.test.ts; the PostgreSQL
 * implementations live in store.ts.
 * @module pipeline/stage-core
 */
import type { ChunkSpec } from './chunk.js'

export interface ChunkWriter {
  upsertChunks(versionId: string, rows: ChunkSpec[]): Promise<void>
  /** Removes chunks (and anything derived from them) with ordinal >= fromOrdinal. */
  deleteChunksFrom(versionId: string, fromOrdinal: number): Promise<number>
}

export async function writeChunks(
  writer: ChunkWriter,
  versionId: string,
  specs: ChunkSpec[],
  batchSize: number,
  afterBatch?: (written: number, total: number) => Promise<void>,
): Promise<{ written: number; trimmed: number }> {
  let written = 0
  for (let i = 0; i < specs.length; i += batchSize) {
    const batch = specs.slice(i, i + batchSize)
    await writer.upsertChunks(versionId, batch)
    written += batch.length
    await afterBatch?.(written, specs.length)
  }
  const trimmed = await writer.deleteChunksFrom(versionId, specs.length)
  return { written, trimmed }
}

export interface PendingChunk {
  id: string
  text: string
  heading: string | null
}

export interface EmbeddingRow {
  chunkId: string
  versionId: string
  vector: number[]
  model: string
}

export interface EmbedStore {
  missingChunks(versionId: string): Promise<PendingChunk[]>
  upsertEmbeddings(rows: EmbeddingRow[]): Promise<void>
}

export type EmbedFn = (inputs: string[]) => Promise<{ vectors: number[][]; model: string }>

/** What the embedder sees for a chunk: its heading gives a short chunk its context. */
export function embeddingInput(chunk: { text: string; heading: string | null }): string {
  return chunk.heading && !chunk.text.includes(chunk.heading) ? `${chunk.heading}\n${chunk.text}` : chunk.text
}

export async function embedMissing(
  store: EmbedStore,
  versionId: string,
  batchSize: number,
  embedFn: EmbedFn,
  afterBatch?: (embeddedNow: number, missingAtStart: number) => Promise<void>,
): Promise<{ embedded: number; skipped: number }> {
  const missing = await store.missingChunks(versionId)
  let embedded = 0
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize)
    const { vectors, model } = await embedFn(batch.map(embeddingInput))
    await store.upsertEmbeddings(batch.map((c, k) => ({ chunkId: c.id, versionId, vector: vectors[k], model })))
    embedded += batch.length
    await afterBatch?.(embedded, missing.length)
  }
  return { embedded, skipped: 0 }
}

export type ActivationDecision = 'activate' | 'stale' | 'document_deleted'

export function decideActivation(doc: { deletedAt: Date | string | null; currentVersionNo: number | null }, versionNo: number): ActivationDecision {
  if (doc.deletedAt !== null) return 'document_deleted'
  if (doc.currentVersionNo !== null && doc.currentVersionNo >= versionNo) return 'stale'
  return 'activate'
}
