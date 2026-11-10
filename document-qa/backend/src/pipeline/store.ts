/**
 * PostgreSQL implementations of the stage-core stores.
 * @module pipeline/store
 */
import { pool, type Queryable } from '../shared/db.js'
import { chunkId } from '../shared/ids.js'
import type { ChunkSpec } from './chunk.js'
import type { ChunkWriter, EmbedStore, EmbeddingRow, PendingChunk } from './stage-core.js'

export function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

export function pgChunkWriter(documentId: string, orgId: string, db: Queryable = pool): ChunkWriter {
  return {
    async upsertChunks(versionId: string, rows: ChunkSpec[]) {
      if (rows.length === 0) return
      const values: unknown[] = []
      const tuples = rows.map((r, i) => {
        const b = i * 10
        values.push(chunkId(versionId, r.ordinal), versionId, documentId, orgId, r.ordinal, r.text, r.charStart, r.charEnd, r.heading, r.tokenCount)
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`
      })
      await db.query(
        `INSERT INTO chunks (id, version_id, document_id, org_id, ordinal, text, char_start, char_end, heading, token_count)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (version_id, ordinal) DO UPDATE SET
           text = EXCLUDED.text, char_start = EXCLUDED.char_start, char_end = EXCLUDED.char_end,
           heading = EXCLUDED.heading, token_count = EXCLUDED.token_count`,
        values,
      )
    },
    async deleteChunksFrom(versionId: string, fromOrdinal: number) {
      const ids = `SELECT id FROM chunks WHERE version_id = $1 AND ordinal >= $2`
      await db.query(`DELETE FROM index_entries WHERE chunk_id IN (${ids})`, [versionId, fromOrdinal])
      await db.query(`DELETE FROM chunk_embeddings WHERE chunk_id IN (${ids})`, [versionId, fromOrdinal])
      const { rowCount } = await db.query(`DELETE FROM chunks WHERE version_id = $1 AND ordinal >= $2`, [versionId, fromOrdinal])
      return rowCount ?? 0
    },
  }
}

export function pgEmbedStore(db: Queryable = pool): EmbedStore {
  return {
    async missingChunks(versionId: string): Promise<PendingChunk[]> {
      const { rows } = await db.query<PendingChunk>(
        `SELECT c.id, c.text, c.heading FROM chunks c
           LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id
          WHERE c.version_id = $1 AND e.chunk_id IS NULL
          ORDER BY c.ordinal`,
        [versionId],
      )
      return rows
    },
    async upsertEmbeddings(rows: EmbeddingRow[]) {
      if (rows.length === 0) return
      const values: unknown[] = []
      const tuples = rows.map((r, i) => {
        values.push(r.chunkId, r.versionId, r.model, vectorLiteral(r.vector))
        return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}::vector)`
      })
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, version_id, model, embedding) VALUES ${tuples.join(', ')}
         ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`,
        values,
      )
    },
  }
}
