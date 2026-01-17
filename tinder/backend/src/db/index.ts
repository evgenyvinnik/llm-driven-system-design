import { Pool } from 'pg';
import Redis from 'ioredis';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';

// PostgreSQL connection pool
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'tinder',
  password: process.env.POSTGRES_PASSWORD || 'tinder_password',
  database: process.env.POSTGRES_DB || 'tinder_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis client
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

// Elasticsearch client
export const elasticsearch = new ElasticsearchClient({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
});

// Initialize Elasticsearch index for users
export async function initElasticsearchIndex(): Promise<void> {
  const indexName = 'users';

  try {
    const indexExists = await elasticsearch.indices.exists({ index: indexName });

    if (!indexExists) {
      await elasticsearch.indices.create({
        index: indexName,
        body: {
          mappings: {
            properties: {
              id: { type: 'keyword' },
              name: { type: 'text' },
              gender: { type: 'keyword' },
              age: { type: 'integer' },
              location: { type: 'geo_point' },
              last_active: { type: 'date' },
              show_me: { type: 'boolean' },
              interested_in: { type: 'keyword' },
            },
          },
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
          },
        },
      });
      console.log('Elasticsearch index created: users');
    }
  } catch (error) {
    console.error('Error initializing Elasticsearch index:', error);
  }
}

// Test database connections
export async function testConnections(): Promise<void> {
  try {
    // Test PostgreSQL
    const pgResult = await pool.query('SELECT NOW()');
    console.log('PostgreSQL connected:', pgResult.rows[0].now);

    // Test Redis
    const redisResult = await redis.ping();
    console.log('Redis connected:', redisResult);

    // Test Elasticsearch
    const esResult = await elasticsearch.ping();
    console.log('Elasticsearch connected:', esResult);
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
}
