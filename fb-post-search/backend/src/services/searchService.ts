/**
 * @fileoverview Core search service for the post search system.
 * Handles Elasticsearch query building, privacy filtering, personalized ranking,
 * search suggestions, and search history management.
 * Includes Prometheus metrics, circuit breaker protection, and structured logging.
 */

import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';
import { getUserVisibilitySet } from './visibilityService.js';
import { query } from '../config/database.js';
import { redis, cacheKeys, setCache, getCache } from '../config/redis.js';
import {
  recordSearchMetrics,
  recordCacheAccess,
  logSearch,
  logger,
  executeWithCircuitBreaker,
  isElasticsearchCircuitOpen,
} from '../shared/index.js';
import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchFilters,
  SearchSuggestion,
  PostDocument,
} from '../types/index.js';

/**
 * Builds an Elasticsearch query with privacy filtering and personalized ranking.
 * Constructs a bool query with:
 * - must: Text matching with multi_match across content, author_name, hashtags
 * - filter: Privacy filters using visibility fingerprints, date range, post type
 * - should: Boosting for friends' posts and user's own posts
 * @param searchQuery - The text query to search for
 * @param filters - Optional filter criteria
 * @param userId - The searching user's ID (undefined for anonymous)
 * @param from - Pagination offset
 * @param size - Number of results to return
 * @returns Elasticsearch query object ready for execution
 */
async function buildSearchQuery(
  searchQuery: string,
  filters: SearchFilters | undefined,
  userId: string | undefined,
  from: number,
  size: number
) {
  const must: object[] = [];
  const filter: object[] = [];
  const should: object[] = [];

  // Main text search
  if (searchQuery && searchQuery.trim()) {
    must.push({
      multi_match: {
        query: searchQuery,
        fields: ['content^3', 'author_name^2', 'hashtags^2'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  // Privacy filtering - most important!
  if (userId) {
    const visibilitySet = await getUserVisibilitySet(userId);

    filter.push({
      terms: {
        visibility_fingerprints: visibilitySet.fingerprints,
      },
    });

    // Boost posts from friends
    const friendIds = visibilitySet.friendIds;
    if (friendIds.length > 0) {
      should.push({
        terms: {
          author_id: friendIds,
          boost: 2.0,
        },
      });
    }

    // Boost own posts
    should.push({
      term: {
        author_id: {
          value: userId,
          boost: 3.0,
        },
      },
    });
  } else {
    // Anonymous users can only see public posts
    filter.push({
      term: {
        visibility: 'public',
      },
    });
  }

  // Date range filter
  if (filters?.date_range) {
    const rangeQuery: { gte?: string; lte?: string } = {};
    if (filters.date_range.start) {
      rangeQuery.gte = filters.date_range.start;
    }
    if (filters.date_range.end) {
      rangeQuery.lte = filters.date_range.end;
    }
    if (Object.keys(rangeQuery).length > 0) {
      filter.push({
        range: {
          created_at: rangeQuery,
        },
      });
    }
  }

  // Post type filter
  if (filters?.post_type && filters.post_type.length > 0) {
    filter.push({
      terms: {
        post_type: filters.post_type,
      },
    });
  }

  // Author filter
  if (filters?.author_ids && filters.author_ids.length > 0) {
    filter.push({
      terms: {
        author_id: filters.author_ids,
      },
    });
  }

  // Visibility filter
  if (filters?.visibility && filters.visibility.length > 0) {
    filter.push({
      terms: {
        visibility: filters.visibility,
      },
    });
  }

  return {
    query: {
      bool: {
        must,
        filter,
        should,
      },
    },
    from,
    size,
    sort: [
      { _score: { order: 'desc' } },
      { engagement_score: { order: 'desc' } },
      { created_at: { order: 'desc' } },
    ],
    highlight: {
      fields: {
        content: {
          fragment_size: 200,
          number_of_fragments: 1,
          pre_tags: ['<em>'],
          post_tags: ['</em>'],
        },
      },
    },
  };
}

/**
 * Executes a search query against the posts index.
 * Handles pagination, privacy filtering, friend boosting, and result highlighting.
 * Records search in history for authenticated users and updates trending searches.
 * Protected by circuit breaker for Elasticsearch failures.
 * @param request - Search request containing query, filters, pagination, and user context
 * @returns Promise resolving to search results with metadata
 */
export async function searchPosts(request: SearchRequest): Promise<SearchResponse> {
  const startTime = Date.now();
  const hasUser = !!request.user_id;

  // Check if circuit breaker is open - fail fast
  if (isElasticsearchCircuitOpen()) {
    logger.warn('Search request rejected - Elasticsearch circuit breaker is open');
    recordSearchMetrics(0, 'error', hasUser, 0);
    throw new Error('Search service temporarily unavailable');
  }

  try {
    const limit = request.pagination?.limit || 20;
    const from = request.pagination?.cursor ? parseInt(request.pagination.cursor, 10) : 0;

    const esQuery = await buildSearchQuery(
      request.query,
      request.filters,
      request.user_id,
      from,
      limit
    );

    interface EsHit {
      _id: string;
      _score: number;
      _source: PostDocument;
      highlight?: {
        content?: string[];
      };
    }

    // Execute search with circuit breaker protection
    const response = await executeWithCircuitBreaker(async () => {
      return esClient.search<PostDocument>({
        index: POSTS_INDEX,
        body: esQuery,
      });
    });

    const hits = response.hits.hits as EsHit[];
    const total = typeof response.hits.total === 'object'
      ? response.hits.total.value
      : response.hits.total || 0;

    const results: SearchResult[] = hits.map((hit) => {
      const source = hit._source;
      const highlight = hit.highlight?.content?.[0] || source.content.substring(0, 200);

      return {
        post_id: source.post_id,
        author_id: source.author_id,
        author_name: source.author_name,
        content: source.content,
        snippet: highlight,
        hashtags: source.hashtags,
        created_at: source.created_at,
        visibility: source.visibility,
        post_type: source.post_type,
        engagement_score: source.engagement_score,
        like_count: source.like_count,
        comment_count: source.comment_count,
        relevance_score: hit._score,
      };
    });

    // Record search in history if user is logged in
    if (request.user_id && request.query.trim()) {
      recordSearchHistory(request.user_id, request.query, request.filters, results.length).catch(
        (err) => logger.error({ error: err }, 'Failed to record search history')
      );

      // Update trending searches
      updateTrendingSearches(request.query).catch(
        (err) => logger.error({ error: err }, 'Failed to update trending searches')
      );
    }

    const nextCursor = from + results.length < total ? String(from + limit) : undefined;
    const durationMs = Date.now() - startTime;

    // Record metrics
    recordSearchMetrics(durationMs / 1000, 'success', hasUser, results.length);

    // Log search operation
    logSearch({
      query: request.query,
      userId: request.user_id,
      filters: request.filters as Record<string, unknown> | undefined,
      resultsCount: results.length,
      durationMs,
    });

    return {
      results,
      next_cursor: nextCursor,
      total_estimate: total,
      took_ms: durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    recordSearchMetrics(durationMs / 1000, 'error', hasUser, 0);
    logger.error({ error, query: request.query }, 'Search failed');
    throw error;
  }
}

/**
 * Records a search query in the user's search history.
 * Used for personalization and analytics.
 * @param userId - The user's ID
 * @param queryText - The search query text
 * @param filters - Applied filters (if any)
 * @param resultsCount - Number of results returned
 */
async function recordSearchHistory(
  userId: string,
  queryText: string,
  filters: SearchFilters | undefined,
  resultsCount: number
): Promise<void> {
  await query(
    `INSERT INTO search_history (user_id, query, filters, results_count)
     VALUES ($1, $2, $3, $4)`,
    [userId, queryText, filters ? JSON.stringify(filters) : null, resultsCount]
  );
}

/**
 * Updates the trending searches sorted set in Redis.
 * Increments the score for the search query and maintains top 1000 entries.
 * @param queryText - The search query to track
 */
async function updateTrendingSearches(queryText: string): Promise<void> {
  const normalized = queryText.toLowerCase().trim();
  if (normalized.length < 2) return;

  await redis.zincrby(cacheKeys.trendingSearches(), 1, normalized);

  // Keep only top 1000 trending searches
  await redis.zremrangebyrank(cacheKeys.trendingSearches(), 0, -1001);
}

/**
 * Provides typeahead/autocomplete suggestions for a search prefix.
 * Sources suggestions from:
 * - Hashtag aggregations (if prefix starts with #)
 * - Trending searches matching the prefix
 * - User display names matching the prefix
 * Results are cached for 1 minute to reduce load.
 * @param prefix - The search prefix to get suggestions for
 * @param userId - The user's ID (optional, enables user suggestions)
 * @param limit - Maximum number of suggestions to return
 * @returns Promise resolving to array of suggestions with types and scores
 */
export async function getSearchSuggestions(
  prefix: string,
  userId?: string,
  limit: number = 10
): Promise<SearchSuggestion[]> {
  const suggestions: SearchSuggestion[] = [];
  const normalizedPrefix = prefix.toLowerCase().trim();

  if (normalizedPrefix.length < 2) {
    return suggestions;
  }

  // Check cache
  const cacheKey = cacheKeys.searchSuggestions(normalizedPrefix);
  const cached = await getCache<SearchSuggestion[]>(cacheKey);
  if (cached) {
    recordCacheAccess('suggestions', true);
    return cached.slice(0, limit);
  }
  recordCacheAccess('suggestions', false);

  // 1. Search for hashtag suggestions
  if (normalizedPrefix.startsWith('#')) {
    const hashtagPrefix = normalizedPrefix.substring(1);

    // Use circuit breaker for ES call
    try {
      const response = await executeWithCircuitBreaker(async () => {
        return esClient.search({
          index: POSTS_INDEX,
          body: {
            size: 0,
            aggs: {
              hashtag_suggestions: {
                terms: {
                  field: 'hashtags',
                  size: 20,
                  include: `${hashtagPrefix}.*`,
                },
              },
            },
          },
        });
      });

      interface AggBucket {
        key: string;
        doc_count: number;
      }

      const aggs = response.aggregations as { hashtag_suggestions?: { buckets: AggBucket[] } };
      const buckets = aggs?.hashtag_suggestions?.buckets || [];

      for (const bucket of buckets) {
        suggestions.push({
          text: bucket.key,
          type: 'hashtag',
          score: bucket.doc_count,
        });
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get hashtag suggestions from ES');
      // Continue without hashtag suggestions
    }
  } else {
    // 2. Get trending searches matching prefix
    const trending = await redis.zrevrange(
      cacheKeys.trendingSearches(),
      0,
      99,
      'WITHSCORES'
    );

    for (let i = 0; i < trending.length; i += 2) {
      const text = trending[i];
      const score = parseFloat(trending[i + 1]);

      if (text.startsWith(normalizedPrefix)) {
        suggestions.push({
          text,
          type: 'query',
          score,
        });
      }
    }

    // 3. Search for user suggestions
    if (userId) {
      interface UserRow {
        id: string;
        display_name: string;
        username: string;
      }

      const users = await query<UserRow>(
        `SELECT id, display_name, username FROM users
         WHERE LOWER(display_name) LIKE $1 OR LOWER(username) LIKE $1
         LIMIT 5`,
        [`${normalizedPrefix}%`]
      );

      for (const user of users) {
        suggestions.push({
          text: user.display_name,
          type: 'user',
          score: 1,
        });
      }
    }
  }

  // Sort by score and limit
  suggestions.sort((a, b) => b.score - a.score);
  const result = suggestions.slice(0, limit);

  // Cache for 1 minute
  await setCache(cacheKey, result, 60);

  return result;
}

/**
 * Retrieves a user's recent unique search queries.
 * @param userId - The user's ID
 * @param limit - Maximum number of searches to return
 * @returns Promise resolving to array of recent search query strings
 */
export async function getUserRecentSearches(
  userId: string,
  limit: number = 10
): Promise<string[]> {
  interface SearchRow {
    query: string;
  }

  const searches = await query<SearchRow>(
    `SELECT DISTINCT query FROM search_history
     WHERE user_id = $1
     ORDER BY MAX(created_at) DESC
     LIMIT $2`,
    [userId, limit]
  );

  return searches.map((s) => s.query);
}

/**
 * Retrieves the most popular search queries.
 * @param limit - Maximum number of trending searches to return
 * @returns Promise resolving to array of trending search query strings
 */
export async function getTrendingSearches(limit: number = 10): Promise<string[]> {
  const trending = await redis.zrevrange(cacheKeys.trendingSearches(), 0, limit - 1);
  return trending;
}

/**
 * Deletes all search history for a user.
 * @param userId - The user's ID whose history should be cleared
 * @returns Promise that resolves when history is deleted
 */
export async function deleteSearchHistory(userId: string): Promise<void> {
  await query('DELETE FROM search_history WHERE user_id = $1', [userId]);
}
