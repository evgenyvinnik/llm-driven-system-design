import { Client } from '@elastic/elasticsearch';
import { config } from './index.js';

/**
 * Elasticsearch client instance for full-text issue search.
 * Powers JQL queries and quick search functionality.
 */
export const esClient = new Client({
  node: config.elasticsearch.url,
});

/**
 * Name of the Elasticsearch index storing issue documents.
 */
export const ISSUE_INDEX = 'issues';

/**
 * Initializes the Elasticsearch issues index with appropriate mappings.
 * Creates a custom analyzer for issue text fields and defines field types
 * optimized for issue search (keyword fields for filtering, text for full-text).
 * Called on server startup to ensure the index exists.
 */
export async function initializeElasticsearch(): Promise<void> {
  try {
    const indexExists = await esClient.indices.exists({ index: ISSUE_INDEX });

    if (!indexExists) {
      await esClient.indices.create({
        index: ISSUE_INDEX,
        body: {
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: {
              analyzer: {
                issue_analyzer: {
                  type: 'custom',
                  tokenizer: 'standard',
                  filter: ['lowercase', 'asciifolding'],
                },
              },
            },
          },
          mappings: {
            properties: {
              id: { type: 'integer' },
              key: { type: 'keyword' },
              project_id: { type: 'keyword' },
              project_key: { type: 'keyword' },
              summary: {
                type: 'text',
                analyzer: 'issue_analyzer',
                fields: {
                  keyword: { type: 'keyword' }
                }
              },
              description: { type: 'text', analyzer: 'issue_analyzer' },
              issue_type: { type: 'keyword' },
              status: { type: 'keyword' },
              status_category: { type: 'keyword' },
              priority: { type: 'keyword' },
              assignee_id: { type: 'keyword' },
              assignee_name: { type: 'keyword' },
              reporter_id: { type: 'keyword' },
              reporter_name: { type: 'keyword' },
              sprint_id: { type: 'integer' },
              sprint_name: { type: 'keyword' },
              epic_id: { type: 'integer' },
              epic_key: { type: 'keyword' },
              story_points: { type: 'integer' },
              labels: { type: 'keyword' },
              components: { type: 'keyword' },
              custom_fields: { type: 'object', enabled: true },
              created_at: { type: 'date' },
              updated_at: { type: 'date' },
            },
          },
        },
      });
      console.log('Created Elasticsearch issues index');
    } else {
      console.log('Elasticsearch issues index already exists');
    }
  } catch (error) {
    console.error('Error initializing Elasticsearch:', error);
  }
}

/**
 * Indexes an issue document in Elasticsearch for search.
 * Called when issues are created or updated to keep the search index in sync.
 *
 * @param issue - Issue data to index (denormalized for search)
 */
export async function indexIssue(issue: Record<string, unknown>): Promise<void> {
  await esClient.index({
    index: ISSUE_INDEX,
    id: String(issue.id),
    body: issue,
    refresh: true,
  });
}

/**
 * Removes an issue document from the Elasticsearch index.
 * Called when issues are deleted.
 *
 * @param issueId - ID of the issue to remove from the index
 */
export async function deleteIssueFromIndex(issueId: number): Promise<void> {
  await esClient.delete({
    index: ISSUE_INDEX,
    id: String(issueId),
    refresh: true,
  });
}

/**
 * Executes a search query against the issues index.
 * Used by the search service to find issues matching JQL or text queries.
 *
 * @param query - Elasticsearch query DSL object
 * @returns Array of issue documents with relevance scores
 */
export async function searchIssues(query: Record<string, unknown>): Promise<unknown[]> {
  const result = await esClient.search({
    index: ISSUE_INDEX,
    body: query,
  });

  return result.hits.hits.map((hit) => ({
    ...hit._source as Record<string, unknown>,
    _score: hit._score,
  }));
}
