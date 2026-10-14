/**
 * Article search: Elasticsearch first, PostgreSQL full-text search as fallback.
 *
 * Elasticsearch is a derived index and an optional dependency. When it is
 * down (or not running at all locally), search degrades to the GIN-indexed
 * `articles.search_vector` column instead of failing: coarser ranking
 * (ts_rank_cd instead of BM25, no fuzziness) but the same filters and the
 * same response shape. The response says which engine answered.
 * @module services/search
 */

import { query } from '../db/postgres.js';
import { searchArticles } from '../db/elasticsearch.js';
import { logger } from '../shared/logger.js';

/** Filters shared by both engines. */
export interface SearchOptions {
  topics?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
}

/** Ranked article ids plus the engine that produced them. */
export interface SearchResult {
  ids: string[];
  engine: 'elasticsearch' | 'postgres';
}

/**
 * Search PostgreSQL full-text index. websearch_to_tsquery accepts what users
 * type ("quoted phrases", -exclusions, OR) without raising syntax errors.
 * @param q - User query
 * @param options - Topic and date filters
 * @returns Article ids, best match first
 */
export async function searchArticlesInPostgres(q: string, options: SearchOptions = {}): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT a.id
     FROM articles a, websearch_to_tsquery('english', $1) AS tsq
     WHERE a.search_vector @@ tsq
       AND ($2::text[] IS NULL OR a.topics && $2::text[])
       AND ($3::timestamp IS NULL OR a.published_at >= $3::timestamp)
       AND ($4::timestamp IS NULL OR a.published_at <= $4::timestamp)
     ORDER BY ts_rank_cd(a.search_vector, tsq) DESC, a.published_at DESC
     LIMIT $5`,
    [q, options.topics?.length ? options.topics : null, options.dateFrom ?? null, options.dateTo ?? null, options.limit ?? 20]
  );
  return rows.map(row => row.id);
}

/**
 * Search articles, falling back to PostgreSQL when Elasticsearch fails.
 * @param q - User query
 * @param options - Topic and date filters
 * @returns Ranked ids and the engine used
 */
export async function search(q: string, options: SearchOptions = {}): Promise<SearchResult> {
  try {
    const hits = await searchArticles(q, options);
    return { ids: hits.map(hit => hit.id), engine: 'elasticsearch' };
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Elasticsearch search failed; using PostgreSQL full-text search');
    return { ids: await searchArticlesInPostgres(q, options), engine: 'postgres' };
  }
}
