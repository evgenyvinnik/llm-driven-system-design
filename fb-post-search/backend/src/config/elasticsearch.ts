import { Client } from '@elastic/elasticsearch';
import { config } from '../config/index.js';

export const esClient = new Client({
  node: config.elasticsearch.url,
});

export const POSTS_INDEX = config.elasticsearch.index;

// Index mapping for posts
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
