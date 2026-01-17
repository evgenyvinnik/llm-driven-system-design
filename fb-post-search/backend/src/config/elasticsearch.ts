/**
 * @fileoverview Elasticsearch client configuration and index management.
 * Provides the Elasticsearch client instance, index mapping definitions,
 * and initialization logic for the posts search index.
 */

import { Client } from '@elastic/elasticsearch';
import { config } from '../config/index.js';

/**
 * Elasticsearch client instance configured from environment settings.
 * Used for all search and indexing operations.
 * @constant
 */
export const esClient = new Client({
  node: config.elasticsearch.url,
});

/**
 * Name of the Elasticsearch index used for storing searchable posts.
 * @constant
 */
export const POSTS_INDEX = config.elasticsearch.index;

/**
 * Elasticsearch index mapping for posts documents.
 * Defines field types and analyzers for efficient full-text search with privacy filtering.
 * Key fields include:
 * - content: Full-text searchable with standard analyzer
 * - visibility_fingerprints: Keyword array for efficient privacy filtering
 * - engagement_score: Float for ranking by popularity
 * @constant
 */
export const postsMapping = {
  mappings: {
    properties: {
      post_id: { type: 'keyword' },
      author_id: { type: 'keyword' },
      author_name: { type: 'text' },
      content: {
        type: 'text',
        analyzer: 'standard',
        fields: {
          keyword: { type: 'keyword', ignore_above: 256 },
        },
      },
      hashtags: { type: 'keyword' },
      mentions: { type: 'keyword' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
      visibility: { type: 'keyword' }, // 'public', 'friends', 'friends_of_friends', 'private'
      visibility_fingerprints: { type: 'keyword' }, // For privacy-aware filtering
      post_type: { type: 'keyword' }, // 'text', 'photo', 'video', 'link'
      engagement_score: { type: 'float' },
      like_count: { type: 'integer' },
      comment_count: { type: 'integer' },
      share_count: { type: 'integer' },
      language: { type: 'keyword' },
    },
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        standard: {
          type: 'standard',
          stopwords: '_english_',
        },
      },
    },
  },
};

/**
 * Initializes the Elasticsearch posts index if it doesn't exist.
 * Creates the index with the predefined mapping for proper field types and analyzers.
 * Should be called during application startup before accepting search requests.
 * @returns Promise that resolves when initialization is complete
 * @throws Throws an error if Elasticsearch connection fails
 */
export async function initializeElasticsearch(): Promise<void> {
  try {
    const indexExists = await esClient.indices.exists({ index: POSTS_INDEX });

    if (!indexExists) {
      await esClient.indices.create({
        index: POSTS_INDEX,
        body: postsMapping,
      });
      console.log(`Created Elasticsearch index: ${POSTS_INDEX}`);
    } else {
      console.log(`Elasticsearch index ${POSTS_INDEX} already exists`);
    }
  } catch (error) {
    console.error('Failed to initialize Elasticsearch:', error);
    throw error;
  }
}
