/**
 * Hybrid search over the user's own data.
 *
 *   keyword list  ─┐
 *   vector list   ─┼─▶ reciprocal rank fusion ─▶ rerank top 50 ─▶ access re-check ─▶ top N
 *   fresh list    ─┘   (mail not yet indexed, read straight from the mailbox)
 *
 * The permission filter (`acl && principals`) runs inside both index queries.
 * Filtering afterwards could leave nothing when the top results were all
 * off-limits, and any bug in a post-filter is a leak. Results are checked
 * against the source tables once more before they are returned, because the
 * index can lag a permission change by a moment.
 * @module retrieval/search
 */
import { pool, type Queryable } from '../shared/db.js'
import { retrievalSeconds } from '../shared/metrics.js'
import { concept, embed, stem, tokenize, toVectorLiteral } from './embed.js'
import { reciprocalRankFusion, rerankScore } from './fuse.js'

export type SourceType = 'mail' | 'doc'

export interface SearchParams {
  userId: string
  orgId: string
  principals: string[]
  query: string
  sourceTypes: SourceType[]
  from?: string
  after?: Date
  before?: Date
  limit: number
}

export interface Passage {
  chunkId: string
  sourceType: SourceType
  sourceId: string
  title: string
  author: string
  authorEmail: string
  date: Date
  anchor: string | null
  text: string
  isExternal: boolean
  fresh: boolean
  score: number
  ranks: { keyword?: number; vector?: number; fresh?: number }
}

export interface SearchResult {
  passages: Passage[]
  stats: { keyword: number; vector: number; fresh: number; fused: number; filteredByAccessCheck: number; ms: number }
}

const CANDIDATES = 50
/** Reranked passages below this score share almost nothing with the query and are dropped. */
const MIN_RELEVANCE = 0.2

interface ChunkRow {
  id: string
  source_type: SourceType
  source_id: string
  title: string
  author: string
  author_email: string
  source_date: Date
  anchor: string | null
  text: string
  is_external: boolean
}

/** Builds an OR tsquery ("dana | budget") from sanitized terms. */
export function keywordQuery(query: string): string | null {
  const terms = [...new Set(tokenize(query).map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean))]
  return terms.length ? terms.map((t) => `${t}:*`).join(' | ') : null
}

function filterClauses(params: SearchParams, values: unknown[]): string {
  const clauses = ['org_id = $1', 'acl && $2::text[]', 'source_type = ANY($3::text[])']
  values.push(params.orgId, params.principals, params.sourceTypes)
  if (params.from) {
    values.push(`%${params.from}%`)
    clauses.push(`(author ILIKE $${values.length} OR author_email ILIKE $${values.length})`)
  }
  if (params.after) {
    values.push(params.after)
    clauses.push(`source_date >= $${values.length}`)
  }
  if (params.before) {
    values.push(params.before)
    clauses.push(`source_date < $${values.length}`)
  }
  return clauses.join(' AND ')
}

async function keywordList(db: Queryable, params: SearchParams): Promise<string[]> {
  const tsquery = keywordQuery(params.query)
  if (!tsquery) return []
  const values: unknown[] = []
  const where = filterClauses(params, values)
  values.push(tsquery)
  const q = `to_tsquery('english', $${values.length})`
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM chunks WHERE ${where} AND tsv @@ ${q} ORDER BY ts_rank_cd(tsv, ${q}) DESC, source_date DESC LIMIT ${CANDIDATES}`,
    values,
  )
  return rows.map((r) => r.id)
}

async function vectorList(db: Queryable, params: SearchParams): Promise<string[]> {
  const values: unknown[] = []
  const where = filterClauses(params, values)
  if (!params.query.trim() || params.query.trim() === '*') {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM chunks WHERE ${where} ORDER BY source_date DESC LIMIT ${CANDIDATES}`,
      values,
    )
    return rows.map((r) => r.id)
  }
  values.push(toVectorLiteral(embed(params.query)))
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM chunks WHERE ${where} ORDER BY embedding <=> $${values.length}::vector LIMIT ${CANDIDATES}`,
    values,
  )
  return rows.map((r) => r.id)
}

/**
 * Mail that arrived after the last indexer pass: anything with an unprocessed
 * upsert event is read straight from the user's mailbox and matched by
 * keyword, so a message from ten seconds ago is still findable.
 */
async function freshMail(db: Queryable, params: SearchParams): Promise<Passage[]> {
  if (!params.sourceTypes.includes('mail')) return []
  const values: unknown[] = [params.userId]
  const clauses = [
    `e.user_id = $1`,
    `m.id IN (SELECT source_id FROM index_events WHERE source_type = 'mail' AND op = 'upsert' AND processed_at IS NULL)`,
  ]
  if (params.from) {
    values.push(`%${params.from}%`)
    clauses.push(`(m.from_name ILIKE $${values.length} OR m.from_email ILIKE $${values.length})`)
  }
  if (params.after) {
    values.push(params.after)
    clauses.push(`m.sent_at >= $${values.length}`)
  }
  if (params.before) {
    values.push(params.before)
    clauses.push(`m.sent_at < $${values.length}`)
  }
  const { rows } = await db.query<{
    id: string
    subject: string
    from_name: string
    from_email: string
    sent_at: Date
    body_text: string
    is_external: boolean
  }>(
    `SELECT m.id, m.subject, m.from_name, m.from_email, m.sent_at, m.body_text, m.is_external
       FROM mail_messages m JOIN mailbox_entries e ON e.message_id = m.id
      WHERE ${clauses.join(' AND ')} ORDER BY m.sent_at DESC LIMIT 20`,
    values,
  )
  const terms = tokenize(params.query).map(stem)
  return rows
    .filter((row) => {
      if (terms.length === 0) return true
      const haystack = tokenize(`${row.subject} ${row.from_name} ${row.body_text}`).map(stem)
      return terms.some((t) => haystack.includes(t))
    })
    .map((row) => ({
      chunkId: `fresh:${row.id}`,
      sourceType: 'mail' as const,
      sourceId: row.id,
      title: row.subject,
      author: row.from_name,
      authorEmail: row.from_email,
      date: row.sent_at,
      anchor: null,
      text: row.body_text.slice(0, 1200),
      isExternal: row.is_external,
      fresh: true,
      score: 0,
      ranks: {},
    }))
}

/** Second, authoritative access check against the source tables. */
async function stillVisible(db: Queryable, params: SearchParams, passages: Passage[]): Promise<Set<string>> {
  const mailIds = passages.filter((p) => p.sourceType === 'mail').map((p) => p.sourceId)
  const docIds = passages.filter((p) => p.sourceType === 'doc').map((p) => p.sourceId)
  const visible = new Set<string>()
  if (mailIds.length) {
    const { rows } = await db.query<{ message_id: string }>(
      'SELECT message_id FROM mailbox_entries WHERE user_id = $1 AND message_id = ANY($2::text[])',
      [params.userId, mailIds],
    )
    rows.forEach((r) => visible.add(r.message_id))
  }
  if (docIds.length) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT d.id FROM documents d
        WHERE d.id = ANY($1::text[])
          AND (d.owner_id = $2 OR EXISTS (SELECT 1 FROM doc_shares s WHERE s.doc_id = d.id AND s.principal = ANY($3::text[])))`,
      [docIds, params.userId, params.principals],
    )
    rows.forEach((r) => visible.add(r.id))
  }
  return visible
}

export async function hybridSearch(params: SearchParams, db: Queryable = pool): Promise<SearchResult> {
  const started = Date.now()
  const [keyword, vector, fresh] = await Promise.all([keywordList(db, params), vectorList(db, params), freshMail(db, params)])
  const freshIds = fresh.map((p) => p.chunkId)
  const fused = reciprocalRankFusion([keyword, vector, freshIds])

  const indexedIds = [...fused.keys()].filter((id) => !id.startsWith('fresh:'))
  const { rows } = indexedIds.length
    ? await db.query<ChunkRow>(
        `SELECT id, source_type, source_id, title, author, author_email, source_date, anchor, text, is_external
           FROM chunks WHERE id = ANY($1::text[])`,
        [indexedIds],
      )
    : { rows: [] as ChunkRow[] }
  const byId = new Map<string, Passage>()
  for (const row of rows) {
    byId.set(row.id, {
      chunkId: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      author: row.author,
      authorEmail: row.author_email,
      date: row.source_date,
      anchor: row.anchor,
      text: row.text,
      isExternal: row.is_external,
      fresh: false,
      score: 0,
      ranks: {},
    })
  }
  // A message can be both freshly arrived and (from an earlier pass) indexed; keep one copy.
  for (const passage of fresh) {
    if (![...byId.values()].some((p) => p.sourceId === passage.sourceId)) byId.set(passage.chunkId, passage)
  }
  keyword.forEach((id, i) => byId.get(id) && (byId.get(id)!.ranks.keyword = i + 1))
  vector.forEach((id, i) => byId.get(id) && (byId.get(id)!.ranks.vector = i + 1))
  freshIds.forEach((id, i) => byId.get(id) && (byId.get(id)!.ranks.fresh = i + 1))

  // Rerank the top fused candidates, then keep the best chunk per source.
  const candidates = [...byId.values()]
    .sort((a, b) => (fused.get(b.chunkId) ?? 0) - (fused.get(a.chunkId) ?? 0))
    .slice(0, CANDIDATES)
  const filterOnly = !params.query.trim() || params.query.trim() === '*'
  for (const passage of candidates) {
    passage.score = rerankScore(params.query, passage) + (fused.get(passage.chunkId) ?? 0)
  }
  const relevant = filterOnly ? candidates : candidates.filter((p) => p.score - (fused.get(p.chunkId) ?? 0) >= MIN_RELEVANCE)
  relevant.sort((a, b) => b.score - a.score)
  const bestPerSource: Passage[] = []
  const seen = new Set<string>()
  for (const passage of relevant) {
    const key = `${passage.sourceType}:${passage.sourceId}`
    if (seen.has(key)) continue
    seen.add(key)
    bestPerSource.push(passage)
  }

  const top = bestPerSource.slice(0, params.limit * 2)
  const visible = await stillVisible(db, params, top)
  const passages = top.filter((p) => visible.has(p.sourceId)).slice(0, params.limit)
  const ms = Date.now() - started
  retrievalSeconds.observe({ source: params.sourceTypes.join('+') }, ms / 1000)
  return {
    passages,
    stats: {
      keyword: keyword.length,
      vector: vector.length,
      fresh: fresh.length,
      fused: fused.size,
      filteredByAccessCheck: top.length - top.filter((p) => visible.has(p.sourceId)).length,
      ms,
    },
  }
}

/** Query concepts, exported for tests and the eval report. */
export function queryConcepts(query: string): string[] {
  return [...new Set(tokenize(query).map(concept))]
}
