import { esClient, ISSUE_INDEX } from '../config/elasticsearch.js';
import { logger } from '../config/logger.js';
import { searchQueriesCounter, searchLatencyHistogram } from '../config/metrics.js';
import { jqlParser } from './jqlParser.js';

/**
 * Options for issue search queries.
 */
export interface SearchOptions {
  /** JQL query string */
  jql?: string;
  /** Full-text search query */
  text?: string;
  /** Filter to specific project */
  projectId?: string;
  /** Maximum results to return (default: 50) */
  limit?: number;
  /** Number of results to skip for pagination */
  offset?: number;
  /** Field to sort by (default: updated_at) */
  sortField?: string;
  /** Sort direction (default: desc) */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Result of a search query.
 */
export interface SearchResult {
  /** Array of matching issue documents */
  issues: Record<string, unknown>[];
  /** Total number of matches */
  total: number;
  /** Query execution time in milliseconds */
  took: number;
}

/**
 * Searches issues using JQL and/or full-text search.
 * Combines JQL parsing with Elasticsearch queries for powerful issue filtering.
 *
 * @param options - Search parameters including JQL, text, filters, and pagination
 * @param currentUserId - ID of current user for resolving currentUser() function
 * @returns Search results with issues, total count, and timing
 * @throws Error if JQL syntax is invalid or search fails
 */
export async function searchIssuesWithJQL(
  options: SearchOptions,
  currentUserId?: string
): Promise<SearchResult> {
  const log = logger.child({ operation: 'searchIssuesWithJQL' });
  const startTime = Date.now();
  const must: Record<string, unknown>[] = [];

  // Determine query type for metrics
  const queryType = options.jql ? 'jql' : options.text ? 'text' : 'filter';

  // Parse JQL if provided
  if (options.jql && options.jql.trim()) {
    try {
      const ast = jqlParser.parse(options.jql);
      const esQuery = jqlParser.toElasticsearch(ast, { currentUserId });
      must.push(esQuery);
    } catch (error) {
      log.warn({ err: error, jql: options.jql }, 'JQL parse error');
      throw new Error(`Invalid JQL: ${(error as Error).message}`);
    }
  }

  // Add project filter if specified
  if (options.projectId) {
    must.push({ term: { project_id: options.projectId } });
  }

  // Add text search if specified
  if (options.text && options.text.trim()) {
    must.push({
      multi_match: {
        query: options.text,
        fields: ['summary^3', 'description', 'key^2'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  }

  const query: Record<string, unknown> = {
    bool: {
      must: must.length > 0 ? must : [{ match_all: {} }],
    },
  };

  const body: Record<string, unknown> = {
    query,
    from: options.offset || 0,
    size: options.limit || 50,
    sort: [
      { [options.sortField || 'updated_at']: { order: options.sortOrder || 'desc' } },
    ],
    track_total_hits: true,
  };

  try {
    const result = await esClient.search({
      index: ISSUE_INDEX,
      body,
    });

    const total = typeof result.hits.total === 'number'
      ? result.hits.total
      : result.hits.total?.value || 0;

    const duration = Date.now() - startTime;

    // Record metrics
    searchQueriesCounter.inc({ query_type: queryType });
    searchLatencyHistogram.observe({ query_type: queryType }, duration / 1000);

    log.debug({ queryType, total, duration_ms: duration }, 'Search completed');

    return {
      issues: result.hits.hits.map((hit) => ({
        ...hit._source as Record<string, unknown>,
        _score: hit._score,
      })),
      total,
      took: duration,
    };
  } catch (error) {
    log.error({ err: error }, 'Elasticsearch search error');
    throw new Error('Search failed');
  }
}

/**
 * Gets autocomplete suggestions for a JQL field.
 * Returns possible values for a field based on existing data.
 *
 * @param field - Field name to get suggestions for (status, assignee, etc.)
 * @param prefix - Prefix to filter suggestions
 * @param projectId - Optional project to scope suggestions
 * @returns Array of matching field values
 */
export async function getSearchSuggestions(
  field: string,
  prefix: string,
  projectId?: string
): Promise<string[]> {
  const fieldMap: Record<string, string> = {
    status: 'status',
    assignee: 'assignee_name',
    reporter: 'reporter_name',
    priority: 'priority',
    type: 'issue_type',
    labels: 'labels',
    sprint: 'sprint_name',
  };

  const esField = fieldMap[field] || field;

  const must: Record<string, unknown>[] = [];
  if (projectId) {
    must.push({ term: { project_id: projectId } });
  }

  try {
    const result = await esClient.search({
      index: ISSUE_INDEX,
      body: {
        size: 0,
        query: must.length > 0 ? { bool: { must } } : { match_all: {} },
        aggs: {
          suggestions: {
            terms: {
              field: esField,
              size: 20,
              include: `${prefix}.*`,
            },
          },
        },
      },
    });

    const buckets = (result.aggregations?.suggestions as { buckets: { key: string }[] })?.buckets || [];
    return buckets.map((b) => b.key);
  } catch (error) {
    logger.error({ err: error }, 'Suggestions error');
    return [];
  }
}

/**
 * Gets aggregated counts for filter facets.
 * Returns counts for statuses, priorities, types, assignees, sprints, and labels.
 *
 * @param projectId - Optional project to scope aggregations
 * @returns Object with arrays of key-count pairs for each facet
 */
export async function getFilterAggregations(
  projectId?: string
): Promise<Record<string, { key: string; count: number }[]>> {
  const must: Record<string, unknown>[] = [];
  if (projectId) {
    must.push({ term: { project_id: projectId } });
  }

  try {
    const result = await esClient.search({
      index: ISSUE_INDEX,
      body: {
        size: 0,
        query: must.length > 0 ? { bool: { must } } : { match_all: {} },
        aggs: {
          statuses: { terms: { field: 'status', size: 50 } },
          priorities: { terms: { field: 'priority', size: 10 } },
          issue_types: { terms: { field: 'issue_type', size: 10 } },
          assignees: { terms: { field: 'assignee_name', size: 50 } },
          sprints: { terms: { field: 'sprint_name', size: 20 } },
          labels: { terms: { field: 'labels', size: 50 } },
        },
      },
    });

    const parseAgg = (agg: unknown): { key: string; count: number }[] => {
      const buckets = (agg as { buckets: { key: string; doc_count: number }[] })?.buckets || [];
      return buckets.map((b) => ({ key: b.key, count: b.doc_count }));
    };

    return {
      statuses: parseAgg(result.aggregations?.statuses),
      priorities: parseAgg(result.aggregations?.priorities),
      issue_types: parseAgg(result.aggregations?.issue_types),
      assignees: parseAgg(result.aggregations?.assignees),
      sprints: parseAgg(result.aggregations?.sprints),
      labels: parseAgg(result.aggregations?.labels),
    };
  } catch (error) {
    logger.error({ err: error }, 'Aggregations error');
    return {};
  }
}

/**
 * Performs a quick text search for issues.
 * Uses fuzzy matching across key, summary, and description.
 * Optimized for type-ahead search UI.
 *
 * @param text - Search query text
 * @param projectId - Optional project to scope search
 * @param limit - Maximum results (default: 10)
 * @returns Array of matching issue documents with scores
 */
export async function quickSearch(
  text: string,
  projectId?: string,
  limit: number = 10
): Promise<Record<string, unknown>[]> {
  const startTime = Date.now();

  const must: Record<string, unknown>[] = [
    {
      multi_match: {
        query: text,
        fields: ['key^5', 'summary^3', 'description'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    },
  ];

  if (projectId) {
    must.push({ term: { project_id: projectId } });
  }

  try {
    const result = await esClient.search({
      index: ISSUE_INDEX,
      body: {
        query: { bool: { must } },
        size: limit,
        _source: ['id', 'key', 'summary', 'issue_type', 'status', 'priority'],
      },
    });

    const duration = Date.now() - startTime;

    // Record metrics
    searchQueriesCounter.inc({ query_type: 'quick' });
    searchLatencyHistogram.observe({ query_type: 'quick' }, duration / 1000);

    return result.hits.hits.map((hit) => ({
      ...hit._source as Record<string, unknown>,
      _score: hit._score,
    }));
  } catch (error) {
    logger.error({ err: error }, 'Quick search error');
    return [];
  }
}

/**
 * Validates JQL syntax without executing the query.
 * Useful for providing real-time syntax feedback in the UI.
 *
 * @param jql - JQL query string to validate
 * @returns Object with valid flag and optional error message
 */
export function validateJQL(jql: string): { valid: boolean; error?: string } {
  try {
    jqlParser.parse(jql);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}
