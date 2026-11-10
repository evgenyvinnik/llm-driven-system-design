/**
 * Retrieval with access enforced twice.
 *
 * 1. Pre-filter inside the search. Both arms (pgvector HNSW and PostgreSQL
 *    full-text) put tenant and access scope in the WHERE clause of the index
 *    query, using the index rows' copy of scope/group and the session's group
 *    claims. Filtering only after a global top-k fails: the k nearest chunks
 *    across all tenants are mostly someone else's, so after filtering an
 *    answer is starved (or empty) although relevant readable chunks exist
 *    further down. pgvector 0.8's iterative scan keeps walking the HNSW graph
 *    until enough rows pass the filter.
 * 2. Re-check against the source of truth (recheck.ts) in the same
 *    REPEATABLE READ snapshot: tombstone, current version, live access.
 *
 * Candidates are fused with reciprocal rank fusion and over-fetched (24 for
 * 5 context slots) so revoked or not-yet-current rows don't starve the answer.
 * @module api/services/retrieval
 */
import type pg from 'pg'
import { config } from '../../shared/config.js'
import { withSnapshot } from '../../shared/db.js'
import { recheckDrops } from '../../shared/metrics.js'
import { words } from '../../shared/text.js'
import { vectorLiteral } from '../../pipeline/store.js'
import { embedBatch } from '../../pipeline/embed-client.js'
import type { AccessUser, Scope } from '../../shared/access.js'
import { recheck, summarizeDrops, type Candidate, type Dropped, type Kept, type TruthRow } from './recheck.js'

export interface RetrievalInput {
  orgId: string
  userId: string
  /** Group ids from the session claims: a pre-filter hint that may be stale. */
  claimedGroups: string[]
  question: string
}

export interface RetrievalResult {
  kept: Kept[]
  dropped: Dropped[]
  candidates: number
  belowThreshold: number
  liveGroups: string[]
  ms: number
}

const RRF_K = 60

interface IndexHit {
  chunk_id: string
  document_id: string
  version_id: string
  scope: string
  group_id: string | null
  acl_epoch: string
  similarity: number
  rank?: number
}

const PREFILTER = `e.org_id = $1 AND (e.scope = 'org' OR e.owner_id = $2 OR (e.scope = 'group' AND e.group_id = ANY($3::text[])))`

export function ftsQuery(question: string): string {
  const parts = [...new Set(words(question).map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length > 1))]
  return parts.join(' | ')
}

/** Reciprocal rank fusion of the two arms. */
export function fuse(vector: IndexHit[], fts: IndexHit[]): Candidate[] {
  const byId = new Map<string, Candidate>()
  const add = (hits: IndexHit[], via: 'vector' | 'fts') => {
    hits.forEach((h, rank) => {
      const cur =
        byId.get(h.chunk_id) ??
        ({
          chunkId: h.chunk_id,
          documentId: h.document_id,
          versionId: h.version_id,
          similarity: Number(h.similarity),
          ftsRank: null,
          fused: 0,
          via: [],
          indexScope: h.scope,
          indexGroupId: h.group_id,
          indexAclEpoch: Number(h.acl_epoch),
        } satisfies Candidate)
      cur.fused += 1 / (RRF_K + rank + 1)
      cur.via.push(via)
      if (via === 'fts') cur.ftsRank = Number(h.rank ?? 0)
      byId.set(h.chunk_id, cur)
    })
  }
  add(vector, 'vector')
  add(fts, 'fts')
  return [...byId.values()].sort((a, b) => b.fused - a.fused || a.chunkId.localeCompare(b.chunkId))
}

/** A vector-only hit must clear the similarity bar; a keyword hit gets a lower one. */
export function relevant(c: Candidate, minSimilarity = config.retrieval.minSimilarity): boolean {
  return c.similarity >= minSimilarity || (c.via.includes('fts') && c.similarity >= minSimilarity / 2)
}

async function loadTruth(client: pg.PoolClient, chunkIds: string[]): Promise<Map<string, TruthRow>> {
  if (chunkIds.length === 0) return new Map()
  const { rows } = await client.query<{
    chunk_id: string
    version_id: string
    version_no: number
    document_id: string
    ordinal: number
    text: string
    char_start: number
    char_end: number
    heading: string | null
    title: string
    org_id: string
    owner_id: string
    scope: Scope
    group_id: string | null
    deleted_at: Date | null
    current_version_id: string | null
    acl_epoch: string
  }>(
    `SELECT c.id AS chunk_id, c.version_id, v.version_no, c.document_id, c.ordinal, c.text, c.char_start, c.char_end, c.heading,
            d.title, d.org_id, d.owner_id, d.scope, d.group_id, d.deleted_at, d.current_version_id, d.acl_epoch
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN document_versions v ON v.id = c.version_id
      WHERE c.id = ANY($1)`,
    [chunkIds],
  )
  return new Map(
    rows.map((r) => [
      r.chunk_id,
      {
        chunkId: r.chunk_id,
        versionId: r.version_id,
        versionNo: r.version_no,
        documentId: r.document_id,
        ordinal: r.ordinal,
        text: r.text,
        charStart: r.char_start,
        charEnd: r.char_end,
        heading: r.heading,
        title: r.title,
        orgId: r.org_id,
        ownerId: r.owner_id,
        scope: r.scope,
        groupId: r.group_id,
        deletedAt: r.deleted_at,
        currentVersionId: r.current_version_id,
        aclEpoch: Number(r.acl_epoch),
      },
    ]),
  )
}

export async function retrieve(input: RetrievalInput): Promise<RetrievalResult> {
  const started = Date.now()
  const { vectors } = await embedBatch([input.question])
  const q = vectorLiteral(vectors[0])
  const tsq = ftsQuery(input.question)
  const k = config.retrieval.candidates

  return withSnapshot(async (client) => {
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(10, Math.min(1000, config.retrieval.efSearch))}`)
    await client.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    const params = [input.orgId, input.userId, input.claimedGroups]
    const vector = await client.query<IndexHit>(
      `SELECT e.chunk_id, e.document_id, e.version_id, e.scope, e.group_id, e.acl_epoch, 1 - (e.embedding <=> $4::vector) AS similarity
         FROM index_entries e WHERE ${PREFILTER}
        ORDER BY e.embedding <=> $4::vector LIMIT ${k}`,
      [...params, q],
    )
    const fts = tsq
      ? await client.query<IndexHit>(
          `SELECT e.chunk_id, e.document_id, e.version_id, e.scope, e.group_id, e.acl_epoch,
                  1 - (e.embedding <=> $4::vector) AS similarity, ts_rank_cd(c.tsv, query) AS rank
             FROM index_entries e JOIN chunks c ON c.id = e.chunk_id, to_tsquery('english', $5) query
            WHERE ${PREFILTER} AND c.tsv @@ query
            ORDER BY rank DESC, e.chunk_id LIMIT ${k}`,
          [...params, q, tsq],
        )
      : { rows: [] as IndexHit[] }

    const fused = fuse(vector.rows, fts.rows).slice(0, k)
    const candidates = fused.filter((c) => relevant(c))
    // Source of truth, same snapshot: chunk rows, document state, live membership.
    const truth = await loadTruth(
      client,
      candidates.map((c) => c.chunkId),
    )
    const { rows: userRows } = await client.query<{ org_id: string | null; active: boolean; groups: string[] | null }>(
      `SELECT u.org_id, u.active, array_remove(array_agg(gm.group_id), NULL) AS groups
         FROM users u LEFT JOIN group_members gm ON gm.user_id = u.id WHERE u.id = $1 GROUP BY u.id`,
      [input.userId],
    )
    const liveGroups = new Set(userRows[0]?.groups ?? [])
    const user: AccessUser = { id: input.userId, orgId: userRows[0]?.org_id ?? null, active: userRows[0]?.active ?? false }
    const { kept, dropped } = recheck(candidates, truth, user, liveGroups)
    for (const d of summarizeDrops(dropped)) recheckDrops.inc({ reason: d.reason }, d.count)
    return {
      kept: kept.slice(0, config.retrieval.contextChunks),
      dropped,
      candidates: candidates.length,
      belowThreshold: fused.length - candidates.length,
      liveGroups: [...liveGroups],
      ms: Date.now() - started,
    }
  })
}
