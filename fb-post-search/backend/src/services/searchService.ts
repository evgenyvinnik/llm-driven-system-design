import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';
import { getUserVisibilitySet, getUserFriendIds } from './visibilityService.js';
import { query } from '../config/database.js';
import { redis, cacheKeys, setCache, getCache } from '../config/redis.js';
import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchFilters,
  SearchSuggestion,
  PostDocument,
} from '../types/index.js';

// Build Elasticsearch query with privacy filtering
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

// Main search function
export async function searchPosts(request: SearchRequest): Promise<SearchResponse> {
  const startTime = Date.now();

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

  const response = await esClient.search<PostDocument>({
    index: POSTS_INDEX,
    body: esQuery,
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
      console.error
    );

    // Update trending searches
    updateTrendingSearches(request.query).catch(console.error);
  }

  const nextCursor = from + results.length < total ? String(from + limit) : undefined;

  return {
    results,
    next_cursor: nextCursor,
    total_estimate: total,
    took_ms: Date.now() - startTime,
  };
}

// Record search in history
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

// Update trending searches using Redis sorted set
async function updateTrendingSearches(queryText: string): Promise<void> {
  const normalized = queryText.toLowerCase().trim();
  if (normalized.length < 2) return;

  await redis.zincrby(cacheKeys.trendingSearches(), 1, normalized);

  // Keep only top 1000 trending searches
  await redis.zremrangebyrank(cacheKeys.trendingSearches(), 0, -1001);
}

// Get search suggestions/typeahead
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
    return cached.slice(0, limit);
  }

  // 1. Search for hashtag suggestions
  if (normalizedPrefix.startsWith('#')) {
    const hashtagPrefix = normalizedPrefix.substring(1);
    const response = await esClient.search({
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

// Get user's recent searches
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

// Get trending searches
export async function getTrendingSearches(limit: number = 10): Promise<string[]> {
  const trending = await redis.zrevrange(cacheKeys.trendingSearches(), 0, limit - 1);
  return trending;
}

// Delete user's search history
export async function deleteSearchHistory(userId: string): Promise<void> {
  await query('DELETE FROM search_history WHERE user_id = $1', [userId]);
}
