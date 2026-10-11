/**
 * People and job search: Elasticsearch first, PostgreSQL full-text as the fallback.
 *
 * Elasticsearch gives fuzzy matching ("Jhon" finds John), skill and company fields and
 * relevance tuning. When it is unreachable (or marked unavailable after a failure),
 * search degrades to PostgreSQL full-text over generated `search_document` columns
 * with GIN indexes instead of returning an error: exact and prefix matches still work,
 * typo tolerance does not. Responses say which engine answered.
 *
 * @module services/searchService
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { searchFallbacksTotal } from '../utils/metrics.js';
import { isSearchAvailable, searchUsers } from '../utils/elasticsearch.js';
import { getUsersByIds } from './userService.js';
import type { User } from '../types/index.js';

export type SearchSource = 'elasticsearch' | 'postgres';

const PUBLIC_USER_COLUMNS = `u.id, u.first_name, u.last_name, u.headline, u.summary, u.location, u.industry,
  u.profile_image_url, u.banner_image_url, u.connection_count, u.role, u.created_at, u.updated_at`;

/**
 * Turns free text into a safe prefix tsquery ("data sci" -> "data:* & sci:*").
 * Only letters and digits survive, so user input can never inject tsquery operators.
 *
 * @param input - Raw search text
 * @returns A to_tsquery string, or null when nothing searchable remains
 */
export function toPrefixQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 8);
  if (unique.length === 0) return null;
  return unique.map((token) => `${token}:*`).join(' & ');
}

/**
 * Full-text people search in PostgreSQL. Names and headline words match by prefix
 * (typeahead), headline and summary also match by English stem ("developers" finds
 * "developer"); results rank by ts_rank with names weighted highest.
 *
 * @param text - Search text
 * @param limit - Maximum results
 * @returns Matching public profiles, best first
 */
export async function searchPeopleInPostgres(text: string, limit: number): Promise<User[]> {
  const prefix = toPrefixQuery(text);
  if (!prefix) return [];
  return query<User>(
    `WITH q AS (
       SELECT to_tsquery('simple', $1) || websearch_to_tsquery('english', $2) AS query
     )
     SELECT ${PUBLIC_USER_COLUMNS}
     FROM users u, q
     WHERE u.search_document @@ q.query
     ORDER BY ts_rank(u.search_document, q.query) DESC, u.connection_count DESC, u.id
     LIMIT $3`,
    [prefix, text, limit]
  );
}

/**
 * Searches people, falling back to PostgreSQL when Elasticsearch can't answer.
 *
 * @param text - Search text
 * @param limit - Maximum results
 * @returns Matching public profiles in relevance order, and which engine answered
 */
export async function searchPeople(
  text: string,
  limit: number
): Promise<{ users: User[]; source: SearchSource }> {
  if (isSearchAvailable()) {
    try {
      const ids = await searchUsers(text, limit);
      return { users: await getUsersByIds(ids), source: 'elasticsearch' };
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'People search fell back to PostgreSQL');
    }
  }
  searchFallbacksTotal.inc({ type: 'user' });
  return { users: await searchPeopleInPostgres(text, limit), source: 'postgres' };
}
