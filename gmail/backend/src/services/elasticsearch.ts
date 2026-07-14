import { Client } from '@elastic/elasticsearch';
import config from '../config/index.js';
import logger from './logger.js';

const esClient = new Client({
  node: config.elasticsearch.node,
});

const EMAIL_INDEX = 'emails';

/**
 * Initialize the Elasticsearch index with proper mappings
 */
export const initializeIndex = async (): Promise<void> => {
  try {
    const exists = await esClient.indices.exists({ index: EMAIL_INDEX });
    if (!exists) {
      await esClient.indices.create({
        index: EMAIL_INDEX,
        body: {
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: {
              analyzer: {
                email_analyzer: {
                  type: 'custom',
                  tokenizer: 'standard',
                  filter: ['lowercase', 'stop'],
                },
              },
            },
          },
          mappings: {
            properties: {
              thread_id: { type: 'keyword' },
              message_id: { type: 'keyword' },
              sender_id: { type: 'keyword' },
              sender_name: { type: 'text' },
              sender_email: { type: 'keyword' },
              recipients: { type: 'keyword' },
              recipient_names: { type: 'text' },
              subject: {
                type: 'text',
                analyzer: 'email_analyzer',
                fields: { keyword: { type: 'keyword' } },
              },
              body: { type: 'text', analyzer: 'email_analyzer' },
              has_attachments: { type: 'boolean' },
              created_at: { type: 'date' },
              visible_to: { type: 'keyword' },
            },
          },
        },
      });
      logger.info('Created Elasticsearch index: emails');
    }
  } catch (error) {
    const err = error as Error;
    logger.error(
      { error: err.message },
      'Failed to initialize Elasticsearch index'
    );
  }
};

/**
 * Index a message in Elasticsearch
 */
export const indexMessage = async (doc: {
  thread_id: string;
  message_id: string;
  sender_id: string;
  sender_name: string;
  sender_email: string;
  recipients: string[];
  recipient_names: string[];
  subject: string;
  body: string;
  has_attachments: boolean;
  created_at: string;
  visible_to: string[];
}): Promise<void> => {
  try {
    await esClient.index({
      index: EMAIL_INDEX,
      id: doc.message_id,
      body: doc,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      { error: err.message, messageId: doc.message_id },
      'Failed to index message'
    );
    throw error;
  }
};

export interface SearchFilters {
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  dateAfter?: string;
  dateBefore?: string;
}

export interface SearchResult {
  threadId: string;
  messageId: string;
  subject: string;
  snippet: string;
  senderName: string;
  senderEmail: string;
  createdAt: string;
  hasAttachments: boolean;
  score: number;
}

/**
 * Search emails for a specific user with optional filters
 */
export const searchEmails = async (
  userId: string,
  queryText: string,
  filters: SearchFilters = {},
  page: number = 1,
  limit: number = 20
): Promise<{ results: SearchResult[]; total: number }> => {
  const must: Record<string, unknown>[] = [
    { term: { visible_to: userId } },
  ];

  if (queryText) {
    must.push({
      multi_match: {
        query: queryText,
        fields: ['subject^3', 'body', 'sender_name', 'recipient_names'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  }

  if (filters.from) {
    must.push({
      bool: {
        should: [
          { match: { sender_name: filters.from } },
          { term: { sender_email: filters.from } },
        ],
      },
    });
  }

  if (filters.to) {
    must.push({
      bool: {
        should: [
          { match: { recipient_names: filters.to } },
          { term: { recipients: filters.to } },
        ],
      },
    });
  }

  if (filters.hasAttachment) {
    must.push({ term: { has_attachments: true } });
  }

  const rangeFilter: Record<string, string> = {};
  if (filters.dateAfter) {
    rangeFilter.gte = filters.dateAfter;
  }
  if (filters.dateBefore) {
    rangeFilter.lte = filters.dateBefore;
  }
  if (Object.keys(rangeFilter).length > 0) {
    must.push({ range: { created_at: rangeFilter } });
  }

  try {
    const response = await esClient.search({
      index: EMAIL_INDEX,
      body: {
        query: { bool: { must } },
        sort: [{ _score: { order: 'desc' } }, { created_at: { order: 'desc' } }],
        from: (page - 1) * limit,
        size: limit,
        _source: [
          'thread_id',
          'message_id',
          'subject',
          'body',
          'sender_name',
          'sender_email',
          'created_at',
          'has_attachments',
        ],
        highlight: {
          fields: {
            body: { fragment_size: 150, number_of_fragments: 1 },
            subject: { fragment_size: 150, number_of_fragments: 1 },
          },
        },
      },
    });

    const hits = response.hits.hits;
    const total =
      typeof response.hits.total === 'number'
        ? response.hits.total
        : response.hits.total?.value || 0;

    const results: SearchResult[] = hits.map((hit) => {
      const source = hit._source as Record<string, unknown>;
      const highlight = hit.highlight as Record<string, string[]> | undefined;
      const bodySnippet =
        highlight?.body?.[0] ||
        (source.body as string)?.substring(0, 150) ||
        '';

      return {
        threadId: source.thread_id as string,
        messageId: source.message_id as string,
        subject:
          highlight?.subject?.[0] || (source.subject as string),
        snippet: bodySnippet,
        senderName: source.sender_name as string,
        senderEmail: source.sender_email as string,
        createdAt: source.created_at as string,
        hasAttachments: source.has_attachments as boolean,
        score: hit._score || 0,
      };
    });

    return { results, total };
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Search failed');
    return { results: [], total: 0 };
  }
};

export const isElasticsearchConnected = async (): Promise<boolean> => {
  try {
    await esClient.ping();
    return true;
  } catch {
    return false;
  }
};

export { esClient, EMAIL_INDEX };
export default esClient;
