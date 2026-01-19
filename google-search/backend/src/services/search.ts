import { db } from '../models/db.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../models/redis.js';
import {
  searchDocuments,
  getAutocompleteSuggestions,
  addSearchSuggestion,
  SearchHit,
} from '../models/elasticsearch.js';
import { config } from '../config/index.js';
import { tokenize, removeStopwords } from '../utils/tokenizer.js';
import { editDistance } from '../utils/helpers.js';

export interface ParsedQuery {
  original: string;
  terms: string[];
  phrases: string[];
  excluded: string[];
  site: string[];
}

export interface SearchResultItem extends SearchHit {
  snippet: string;
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  page: number;
  totalPages: number;
  query: string;
  parsedQuery: ParsedQuery;
  duration: number;
  fromCache: boolean;
}

export interface PopularSearch {
  query: string;
  frequency: number;
}

/**
 * Query Processor - parses and executes search queries
 */
class QueryProcessor {
  /**
   * Parse a query string into structured components
   */
  parseQuery(queryString: string): ParsedQuery {
    const terms: string[] = [];
    const phrases: string[] = [];
    const excluded: string[] = [];
    const site: string[] = [];

    let remaining = queryString.trim();

    // Extract quoted phrases
    const phraseRegex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = phraseRegex.exec(remaining)) !== null) {
      phrases.push(match[1].trim());
    }
    remaining = remaining.replace(/"[^"]+"/g, '');

    // Extract site: filters
    const siteRegex = /site:(\S+)/gi;
    while ((match = siteRegex.exec(remaining)) !== null) {
      site.push(match[1].toLowerCase());
    }
    remaining = remaining.replace(/site:\S+/gi, '');

    // Extract excluded terms (-term)
    const excludeRegex = /-(\w+)/g;
    while ((match = excludeRegex.exec(remaining)) !== null) {
      excluded.push(match[1].toLowerCase());
    }
    remaining = remaining.replace(/-\w+/g, '');

    // Remaining terms
    const remainingTerms = remaining
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => t.toLowerCase());

    terms.push(...remainingTerms);

    return {
      original: queryString,
      terms,
      phrases,
      excluded,
      site,
    };
  }

  /**
   * Get suggestion for a potentially misspelled term
   */
  async getSuggestionForTerm(term: string): Promise<string> {
    // Simple approach: check against popular search terms
    const result = await db.query<{ query: string }>(
      `SELECT query FROM search_suggestions
       WHERE query LIKE $1
       ORDER BY frequency DESC
       LIMIT 5`,
      [`${term.substring(0, 2)}%`]
    );

    if (result.rows.length === 0) return term;

    // Find closest match by edit distance
    let bestMatch = term;
    let bestDistance = Infinity;

    for (const row of result.rows) {
      const distance = editDistance(term, row.query);
      if (distance < bestDistance && distance <= 2) {
        bestDistance = distance;
        bestMatch = row.query;
      }
    }

    return bestMatch;
  }

  /**
   * Execute a search query
   */
  async search(
    queryString: string,
    options: { page?: number; limit?: number } = {}
  ): Promise<SearchResponse> {
    const startTime = Date.now();
    const { page = 1, limit = config.search.resultsPerPage } = options;

    // Check cache first
    const cacheKey = CACHE_KEYS.QUERY_RESULT(queryString.toLowerCase(), page);
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached) as SearchResponse;
      result.fromCache = true;
      return result;
    }

    // Parse query
    const parsed = this.parseQuery(queryString);

    // Build search query for Elasticsearch
    const searchQuery = [...parsed.terms, ...parsed.phrases].join(' ');

    if (searchQuery.trim().length === 0) {
      return {
        results: [],
        total: 0,
        page,
        totalPages: 0,
        query: queryString,
        parsedQuery: parsed,
        duration: Date.now() - startTime,
        fromCache: false,
      };
    }

    // Execute search
    const searchResult = await searchDocuments(searchQuery, { page, limit });

    // Filter results if site: filter is present
    let results = searchResult.hits;
    if (parsed.site.length > 0) {
      results = results.filter((r) =>
        parsed.site.some((s) => r.domain.includes(s))
      );
    }

    // Filter out excluded terms
    if (parsed.excluded.length > 0) {
      results = results.filter((r) => {
        const content = `${r.title} ${r.description}`.toLowerCase();
        return !parsed.excluded.some((ex) => content.includes(ex));
      });
    }

    // Generate snippets from highlights
    const resultsWithSnippets: SearchResultItem[] = results.map((r) => ({
      ...r,
      snippet: this.generateSnippet(r),
    }));

    const duration = Date.now() - startTime;

    const response: SearchResponse = {
      results: resultsWithSnippets,
      total: searchResult.total,
      page,
      totalPages: Math.ceil(searchResult.total / limit),
      query: queryString,
      parsedQuery: parsed,
      duration,
      fromCache: false,
    };

    // Cache the result
    await redis.setex(cacheKey, CACHE_TTL.QUERY_RESULT, JSON.stringify(response));

    // Log the query
    await this.logQuery(queryString, searchResult.total, duration);

    // Add to search suggestions
    if (parsed.terms.length > 0) {
      await addSearchSuggestion(queryString.toLowerCase().trim());
    }

    return response;
  }

  /**
   * Generate a snippet from search highlights
   */
  generateSnippet(result: SearchHit): string {
    if (result.highlight?.content?.length && result.highlight.content.length > 0) {
      return result.highlight.content.join(' ... ');
    }
    if (result.description) {
      return result.description.substring(0, 200) + (result.description.length > 200 ? '...' : '');
    }
    return '';
  }

  /**
   * Log a search query for analytics
   */
  async logQuery(query: string, resultsCount: number, durationMs: number): Promise<void> {
    try {
      await db.query(
        `INSERT INTO query_logs (query, results_count, duration_ms)
         VALUES ($1, $2, $3)`,
        [query, resultsCount, durationMs]
      );
    } catch (error) {
      console.error('Failed to log query:', (error as Error).message);
    }
  }

  /**
   * Get autocomplete suggestions
   */
  async getAutocomplete(prefix: string): Promise<string[]> {
    if (!prefix || prefix.trim().length < 2) {
      return [];
    }

    const cacheKey = CACHE_KEYS.AUTOCOMPLETE(prefix.toLowerCase());
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Try Elasticsearch first
    let suggestions = await getAutocompleteSuggestions(
      prefix.toLowerCase(),
      config.search.autocompleteLimit
    );

    // Fall back to database if no suggestions
    if (suggestions.length === 0) {
      const result = await db.query<{ query: string }>(
        `SELECT query FROM search_suggestions
         WHERE query LIKE $1
         ORDER BY frequency DESC
         LIMIT $2`,
        [`${prefix.toLowerCase()}%`, config.search.autocompleteLimit]
      );
      suggestions = result.rows.map((r) => r.query);
    }

    // Cache suggestions
    await redis.setex(cacheKey, CACHE_TTL.AUTOCOMPLETE, JSON.stringify(suggestions));

    return suggestions;
  }

  /**
   * Get popular searches
   */
  async getPopularSearches(limit = 10): Promise<PopularSearch[]> {
    const result = await db.query<PopularSearch>(
      `SELECT query, frequency
       FROM search_suggestions
       ORDER BY frequency DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Get related searches based on a query
   */
  async getRelatedSearches(query: string, limit = 5): Promise<string[]> {
    const terms = removeStopwords(tokenize(query));
    if (terms.length === 0) return [];

    // Find queries containing similar terms
    const patterns = terms.map((t) => `%${t}%`);

    const result = await db.query<{ query: string }>(
      `SELECT DISTINCT query
       FROM search_suggestions
       WHERE ${patterns.map((_, i) => `query LIKE $${i + 1}`).join(' OR ')}
       AND query != $${patterns.length + 1}
       ORDER BY frequency DESC
       LIMIT $${patterns.length + 2}`,
      [...patterns, query.toLowerCase(), limit]
    );

    return result.rows.map((r) => r.query);
  }
}

export const queryProcessor = new QueryProcessor();
