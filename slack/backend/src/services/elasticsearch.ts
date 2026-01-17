import { Client } from '@elastic/elasticsearch';
import dotenv from 'dotenv';

dotenv.config();

const esUrl = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

export const esClient = new Client({ node: esUrl });

// Index name
const MESSAGES_INDEX = 'slack_messages';

// Initialize Elasticsearch index
export async function initializeElasticsearch(): Promise<void> {
  try {
    const indexExists = await esClient.indices.exists({ index: MESSAGES_INDEX });

    if (!indexExists) {
      await esClient.indices.create({
        index: MESSAGES_INDEX,
        body: {
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: {
              analyzer: {
                message_analyzer: {
                  type: 'custom',
                  tokenizer: 'standard',
                  filter: ['lowercase', 'porter_stem'],
                },
              },
            },
          },
          mappings: {
            properties: {
              id: { type: 'long' },
              workspace_id: { type: 'keyword' },
              channel_id: { type: 'keyword' },
              user_id: { type: 'keyword' },
              content: {
                type: 'text',
                analyzer: 'message_analyzer',
              },
              created_at: { type: 'date' },
            },
          },
        },
      });
      console.log('Elasticsearch index created');
    }
  } catch (error) {
    console.error('Failed to initialize Elasticsearch:', error);
    // Don't throw - search will be unavailable but app should still work
  }
}

// Index a message
export async function indexMessage(message: {
  id: number;
  workspace_id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: Date;
}): Promise<void> {
  try {
    await esClient.index({
      index: MESSAGES_INDEX,
      id: String(message.id),
      document: {
        id: message.id,
        workspace_id: message.workspace_id,
        channel_id: message.channel_id,
        user_id: message.user_id,
        content: message.content,
        created_at: message.created_at,
      },
    });
  } catch (error) {
    console.error('Failed to index message:', error);
  }
}

// Update message in index
export async function updateMessageIndex(id: number, content: string): Promise<void> {
  try {
    await esClient.update({
      index: MESSAGES_INDEX,
      id: String(id),
      doc: { content },
    });
  } catch (error) {
    console.error('Failed to update message index:', error);
  }
}

// Delete message from index
export async function deleteMessageIndex(id: number): Promise<void> {
  try {
    await esClient.delete({
      index: MESSAGES_INDEX,
      id: String(id),
    });
  } catch (error) {
    console.error('Failed to delete message from index:', error);
  }
}

// Search messages
export interface SearchFilters {
  channel_id?: string;
  user_id?: string;
  from_date?: string;
  to_date?: string;
}

export interface SearchResult {
  id: number;
  workspace_id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: Date;
  highlight?: string[];
}

export async function searchMessages(
  workspaceId: string,
  query: string,
  filters: SearchFilters = {},
  limit: number = 50
): Promise<SearchResult[]> {
  try {
    const mustClauses: unknown[] = [
      { term: { workspace_id: workspaceId } },
      { match: { content: query } },
    ];

    const filterClauses: unknown[] = [];

    if (filters.channel_id) {
      filterClauses.push({ term: { channel_id: filters.channel_id } });
    }

    if (filters.user_id) {
      filterClauses.push({ term: { user_id: filters.user_id } });
    }

    if (filters.from_date || filters.to_date) {
      const rangeQuery: { gte?: string; lte?: string } = {};
      if (filters.from_date) rangeQuery.gte = filters.from_date;
      if (filters.to_date) rangeQuery.lte = filters.to_date;
      filterClauses.push({ range: { created_at: rangeQuery } });
    }

    const response = await esClient.search({
      index: MESSAGES_INDEX,
      body: {
        size: limit,
        query: {
          bool: {
            must: mustClauses,
            filter: filterClauses.length > 0 ? filterClauses : undefined,
          },
        },
        highlight: {
          fields: {
            content: {},
          },
        },
        sort: [{ created_at: 'desc' }],
      },
    });

    return response.hits.hits.map((hit) => {
      const source = hit._source as SearchResult;
      return {
        ...source,
        highlight: hit.highlight?.content,
      };
    });
  } catch (error) {
    console.error('Failed to search messages:', error);
    return [];
  }
}
