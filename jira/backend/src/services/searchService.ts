import { esClient, ISSUE_INDEX, searchIssues } from '../config/elasticsearch.js';
import { jqlParser, JQLNode } from './jqlParser.js';

export interface SearchOptions {
  jql?: string;
  text?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface SearchResult {
  issues: Record<string, unknown>[];
  total: number;
  took: number;
}

// Search issues using JQL
export async function searchIssuesWithJQL(
  options: SearchOptions,
  currentUserId?: string
): Promise<SearchResult> {
  const startTime = Date.now();
  const must: Record<string, unknown>[] = [];

  // Parse JQL if provided
  if (options.jql && options.jql.trim()) {
    try {
      const ast = jqlParser.parse(options.jql);
      const esQuery = jqlParser.toElasticsearch(ast, { currentUserId });
      must.push(esQuery);
    } catch (error) {
      console.error('JQL parse error:', error);
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

    return {
      issues: result.hits.hits.map((hit) => ({
        ...hit._source as Record<string, unknown>,
        _score: hit._score,
      })),
      total,
      took: Date.now() - startTime,
    };
  } catch (error) {
    console.error('Elasticsearch search error:', error);
    throw new Error('Search failed');
  }
}

// Get search suggestions/autocomplete
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
    console.error('Suggestions error:', error);
    return [];
  }
}

// Get aggregations for filters
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
    console.error('Aggregations error:', error);
    return {};
  }
}

// Quick search (simple text search)
export async function quickSearch(
  text: string,
  projectId?: string,
  limit: number = 10
): Promise<Record<string, unknown>[]> {
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

    return result.hits.hits.map((hit) => ({
      ...hit._source as Record<string, unknown>,
      _score: hit._score,
    }));
  } catch (error) {
    console.error('Quick search error:', error);
    return [];
  }
}

// Validate JQL syntax
export function validateJQL(jql: string): { valid: boolean; error?: string } {
  try {
    jqlParser.parse(jql);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}
