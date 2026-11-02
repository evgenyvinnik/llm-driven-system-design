import { esClient } from './elasticsearch.js';
import { pool } from './db.js';
import { config } from '../config/index.js';
import { searchLatency } from './metrics.js';
import { logger } from './logger.js';

interface SearchResult {
  page_id: string;
  space_id: string;
  space_key: string;
  slug: string;
  title: string;
  content_text: string;
  labels: string[];
  score: number;
  highlight?: {
    title?: string[];
    content_text?: string[];
  };
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;
  /** True when Elasticsearch was unavailable and results came from the SQL fallback. */
  degraded: boolean;
}

interface IndexedPage {
  id: string;
  space_id: string;
  space_key: string;
  slug: string;
  title: string;
  content_text: string;
  created_by: string;
  updated_at: string;
  status: string;
  version: number;
  labels: string[];
}

const PAGE_DOC_SQL = `
  SELECT p.id, p.space_id, s.key AS space_key, p.slug, p.title, p.content_text,
         p.created_by, p.updated_at, p.status, p.version,
         ARRAY(SELECT label FROM page_labels WHERE page_id = p.id ORDER BY label) AS labels
  FROM pages p JOIN spaces s ON s.id = p.space_id`;

function toDocument(page: IndexedPage): Record<string, unknown> {
  return {
    page_id: page.id,
    space_id: page.space_id,
    space_key: page.space_key,
    slug: page.slug,
    title: page.title,
    content_text: page.content_text,
    labels: page.labels,
    created_by: page.created_by,
    updated_at: page.updated_at,
    status: page.status,
    version: page.version,
  };
}

function isVersionConflict(err: unknown): boolean {
  return (err as { meta?: { statusCode?: number } })?.meta?.statusCode === 409;
}

/**
 * Writes the page's current state to the index. Errors propagate so the
 * worker can retry instead of acknowledging a lost update. Writes carry the
 * page's version as an external version (`external_gte`), so if two index
 * messages for the same page race, an older read cannot overwrite a newer
 * document; equal versions are accepted because label changes do not bump it.
 * A page that no longer exists is removed from the index.
 */
export async function indexPage(pageId: string): Promise<'indexed' | 'stale' | 'removed'> {
  const result = await pool.query(`${PAGE_DOC_SQL} WHERE p.id = $1`, [pageId]);
  const page = result.rows[0] as IndexedPage | undefined;
  if (!page) {
    await deletePageIndex(pageId);
    return 'removed';
  }

  try {
    await esClient.index({
      index: config.elasticsearch.index,
      id: pageId,
      version: page.version,
      version_type: 'external_gte',
      document: toDocument(page),
    });
    return 'indexed';
  } catch (err) {
    if (isVersionConflict(err)) return 'stale';
    throw err;
  }
}

/** Removes a page from the index; an already-missing document is not an error. */
export async function deletePageIndex(pageId: string): Promise<void> {
  try {
    await esClient.delete({ index: config.elasticsearch.index, id: pageId });
  } catch (err) {
    if ((err as { meta?: { statusCode?: number } })?.meta?.statusCode === 404) return;
    throw err;
  }
}

/** Removes every document of a deleted space. */
export async function deleteSpaceIndex(spaceId: string): Promise<void> {
  await esClient.deleteByQuery({
    index: config.elasticsearch.index,
    query: { term: { space_id: spaceId } },
    refresh: true,
    conflicts: 'proceed',
  });
}

/**
 * Reconciles the whole index with Postgres: bulk-writes every page (with
 * external versions, so it never regresses a newer document) and deletes
 * documents whose page no longer exists. The worker runs this at boot and
 * periodically, which bounds how long a lost queue message can leave search
 * stale.
 */
export async function reindexAll(): Promise<{ indexed: number; removed: number }> {
  const pages = (await pool.query(PAGE_DOC_SQL)).rows as IndexedPage[];
  let indexed = 0;

  for (let i = 0; i < pages.length; i += 200) {
    const batch = pages.slice(i, i + 200);
    const operations = batch.flatMap((page) => [
      {
        index: {
          _index: config.elasticsearch.index,
          _id: page.id,
          version: page.version,
          version_type: 'external_gte' as const,
        },
      },
      toDocument(page),
    ]);
    const response = await esClient.bulk({ operations, refresh: false });
    for (const item of response.items) {
      const status = item.index?.status ?? 500;
      if (status < 300 || status === 409) indexed++;
      else logger.warn({ item }, 'Bulk reindex item failed');
    }
  }

  // Drop documents for pages that were deleted while their delete message was lost.
  const known = new Set(pages.map((p) => p.id));
  let removed = 0;
  const all = await esClient.search<{ page_id: string }>({
    index: config.elasticsearch.index,
    size: 10000,
    _source: ['page_id'],
    query: { match_all: {} },
  });
  for (const hit of all.hits.hits) {
    if (hit._id && !known.has(hit._id)) {
      await deletePageIndex(hit._id);
      removed++;
    }
  }

  await esClient.indices.refresh({ index: config.elasticsearch.index });
  return { indexed, removed };
}

/**
 * Searches published pages in the given spaces (the caller's visible spaces,
 * or one of them). Hits are re-checked against Postgres before being returned:
 * the index can lag a delete, an unpublish or a rename, and the stored slug and
 * status are the ones that matter. Falls back to SQL if Elasticsearch fails.
 */
export async function searchPages(
  query: string,
  spaceIds: string[],
  page: number = 1,
  pageSize: number = 20,
): Promise<SearchResponse> {
  if (spaceIds.length === 0) return { results: [], total: 0, took: 0, degraded: false };
  const end = searchLatency.startTimer();

  let response;
  try {
    response = await esClient.search<Record<string, unknown>>({
      index: config.elasticsearch.index,
      from: (page - 1) * pageSize,
      size: pageSize,
      track_total_hits: true,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                fields: ['title^3', 'content_text', 'labels^2'],
                type: 'best_fields',
                fuzziness: 'AUTO',
              },
            },
          ],
          filter: [{ term: { status: 'published' } }, { terms: { space_id: spaceIds } }],
        },
      },
      highlight: {
        // Escape the document text so only the <mark> tags are HTML.
        encoder: 'html',
        fields: {
          title: { number_of_fragments: 1 },
          content_text: { number_of_fragments: 2, fragment_size: 150 },
        },
        pre_tags: ['<mark>'],
        post_tags: ['</mark>'],
      },
    });
  } catch (err) {
    end();
    logger.error({ err, query }, 'Elasticsearch search failed; using SQL fallback');
    return fallbackSearch(query, spaceIds, page, pageSize);
  }
  end();

  const hits = response.hits.hits;
  const ids = hits.map((hit) => hit._id).filter((id): id is string => Boolean(id));
  const current = ids.length
    ? await pool.query(
        `SELECT p.id, p.slug, p.title, p.space_id, s.key AS space_key
         FROM pages p JOIN spaces s ON s.id = p.space_id
         WHERE p.id = ANY($1::uuid[]) AND p.status = 'published' AND p.space_id = ANY($2::uuid[])`,
        [ids, spaceIds],
      )
    : { rows: [] };
  const byId = new Map(current.rows.map((r: { id: string }) => [r.id, r]));

  const results: SearchResult[] = [];
  for (const hit of hits) {
    const row = byId.get(hit._id ?? '') as
      | { id: string; slug: string; title: string; space_id: string; space_key: string }
      | undefined;
    if (!row) continue; // stale document: deleted, unpublished, or moved out of reach
    const source = hit._source as Record<string, unknown>;
    results.push({
      page_id: row.id,
      space_id: row.space_id,
      space_key: row.space_key,
      slug: row.slug,
      title: row.title,
      content_text: String(source.content_text ?? '').slice(0, 300),
      labels: (source.labels as string[]) ?? [],
      score: hit._score || 0,
      highlight: hit.highlight,
    });
  }

  const total =
    typeof response.hits.total === 'number' ? response.hits.total : response.hits.total?.value || 0;
  return { results, total, took: response.took, degraded: false };
}

/** Escapes LIKE metacharacters so a query of "%" or "_" matches itself, not everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function fallbackSearch(
  query: string,
  spaceIds: string[],
  page: number,
  pageSize: number,
): Promise<SearchResponse> {
  const pattern = `%${escapeLike(query)}%`;
  const where = `p.status = 'published' AND p.space_id = ANY($2::uuid[])
                 AND (p.title ILIKE $1 ESCAPE '\\' OR p.content_text ILIKE $1 ESCAPE '\\')`;

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT p.id as page_id, p.space_id, s.key as space_key, p.slug, p.title,
              LEFT(p.content_text, 300) AS content_text,
              ARRAY(SELECT label FROM page_labels WHERE page_id = p.id) as labels
       FROM pages p
       JOIN spaces s ON s.id = p.space_id
       WHERE ${where}
       ORDER BY p.updated_at DESC
       LIMIT $3 OFFSET $4`,
      [pattern, spaceIds, pageSize, (page - 1) * pageSize],
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM pages p WHERE ${where}`, [pattern, spaceIds]),
  ]);

  return {
    results: rows.rows.map((r: SearchResult) => ({ ...r, score: 1.0 })),
    total: count.rows[0].total,
    took: 0,
    degraded: true,
  };
}
