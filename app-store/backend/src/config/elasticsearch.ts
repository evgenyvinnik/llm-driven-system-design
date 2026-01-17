/**
 * @fileoverview Elasticsearch client and index configuration for app search.
 * Provides full-text search, fuzzy matching, and autocomplete suggestions.
 */

import { Client } from '@elastic/elasticsearch';
import { config } from './index.js';

/**
 * Elasticsearch client instance for search operations.
 */
export const esClient = new Client({
  node: config.elasticsearch.url,
});

/** Index name for app documents in Elasticsearch */
export const APP_INDEX = 'apps';

/**
 * Elasticsearch index mapping for app documents.
 * Defines field types, analyzers, and search configurations.
 * Includes completion suggester for autocomplete functionality.
 */
export const appIndexMapping = {
  mappings: {
    properties: {
      id: { type: 'keyword' },
      bundleId: { type: 'keyword' },
      name: {
        type: 'text',
        analyzer: 'standard',
        fields: {
          keyword: { type: 'keyword' },
          suggest: { type: 'completion' },
        },
      },
      developer: {
        type: 'text',
        fields: {
          keyword: { type: 'keyword' },
        },
      },
      developerId: { type: 'keyword' },
      description: { type: 'text' },
      keywords: { type: 'text' },
      category: { type: 'keyword' },
      subcategory: { type: 'keyword' },
      isFree: { type: 'boolean' },
      price: { type: 'float' },
      averageRating: { type: 'float' },
      ratingCount: { type: 'integer' },
      downloadCount: { type: 'long' },
      releaseDate: { type: 'date' },
      lastUpdated: { type: 'date' },
      ageRating: { type: 'keyword' },
      size: { type: 'long' },
      version: { type: 'keyword' },
      iconUrl: { type: 'keyword' },
      screenshots: { type: 'keyword' },
      qualityScore: { type: 'float' },
      engagementScore: { type: 'float' },
    },
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        standard: {
          type: 'standard',
        },
      },
    },
  },
};

/**
 * Creates the apps index if it does not exist.
 * Called during server startup to ensure search infrastructure is ready.
 * @throws Error if Elasticsearch is unreachable or index creation fails
 */
export async function initializeElasticsearch(): Promise<void> {
  try {
    const indexExists = await esClient.indices.exists({ index: APP_INDEX });

    if (!indexExists) {
      await esClient.indices.create({
        index: APP_INDEX,
        body: appIndexMapping,
      });
      console.log(`Created Elasticsearch index: ${APP_INDEX}`);
    } else {
      console.log(`Elasticsearch index ${APP_INDEX} already exists`);
    }
  } catch (error) {
    console.error('Error initializing Elasticsearch:', error);
    throw error;
  }
}
