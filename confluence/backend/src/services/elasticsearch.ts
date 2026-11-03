import { Client } from '@elastic/elasticsearch';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/** Elasticsearch client instance for the wiki search index. */
export const esClient = new Client({
  node: config.elasticsearch.node,
});

/** Creates the wiki_pages Elasticsearch index with custom analyzer if it does not exist. */
export async function ensureIndex(): Promise<void> {
  try {
    const exists = await esClient.indices.exists({ index: config.elasticsearch.index });
    if (!exists) {
      await esClient.indices.create({
        index: config.elasticsearch.index,
        body: {
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: {
              analyzer: {
                wiki_analyzer: {
                  type: 'custom',
                  tokenizer: 'standard',
                  filter: ['lowercase', 'stop', 'snowball'],
                },
              },
            },
          },
          mappings: {
            properties: {
              page_id: { type: 'keyword' },
              slug: { type: 'keyword' },
              version: { type: 'integer' },
              space_id: { type: 'keyword' },
              space_key: { type: 'keyword' },
              title: {
                type: 'text',
                analyzer: 'wiki_analyzer',
                fields: { keyword: { type: 'keyword' } },
              },
              content_text: { type: 'text', analyzer: 'wiki_analyzer' },
              labels: { type: 'keyword' },
              created_by: { type: 'keyword' },
              updated_at: { type: 'date' },
              status: { type: 'keyword' },
            },
          },
        },
      });
      logger.info('Elasticsearch index created: wiki_pages');
    }
  } catch (err) {
    logger.warn({ err }, 'Elasticsearch index creation skipped (may already exist or ES unavailable)');
  }
}
