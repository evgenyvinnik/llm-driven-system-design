import { Pool } from 'pg';
import Redis from 'ioredis';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';

/**
 * PostgreSQL connection pool for relational data storage.
 * Handles user profiles, matches, swipes, and messages with geospatial support via PostGIS.
 * Configured with connection pooling for efficient concurrent query handling.
 */
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

/**
 * Redis client for caching and pub/sub messaging.
 * Caches swipe data for fast mutual-match detection and user location lookups.
 * Also serves as the pub/sub backbone for real-time WebSocket message delivery.
 */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

/**
 * Elasticsearch client for geo-based discovery queries.
 * Provides optimized candidate search with distance-based sorting, bidirectional preference matching,
 * and activity-based ranking. Falls back to PostgreSQL if unavailable.
 */
export const elasticsearch = new ElasticsearchClient({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
});

/**
 * Waits for Elasticsearch to answer a ping, retrying with a fixed backoff.
 * ES 8 with a small heap routinely needs 30-60s to become useful, which is far
 * longer than Postgres or Redis. Everything that touches ES at startup has to
 * tolerate that window rather than assume the cluster is up.
 * @param attempts - Maximum ping attempts before giving up
 * @param delayMs - Delay between attempts
 * @returns true once ES responds, false if it never did
 */
async function waitForElasticsearch(attempts = 30, delayMs = 2000): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await elasticsearch.ping();
      return true;
    } catch {
      if (i === attempts) return false;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * Rebuilds the Elasticsearch 'users' index from PostgreSQL, which is the system
 * of record. Runs at every boot so the index is correct no matter how the
 * database was populated — the SQL seed (`backend/db-seed/seed.sql`) writes rows
 * directly and knows nothing about Elasticsearch, so without this the discovery
 * query matches zero documents and the deck is silently empty.
 * @returns Number of users indexed
 */
export async function backfillElasticsearchIndex(): Promise<number> {
  const result = await pool.query(
    `SELECT u.id, u.name, u.gender, u.latitude, u.longitude, u.last_active,
            calculate_age(u.birthdate) AS age,
            COALESCE(p.show_me, true) AS show_me,
            COALESCE(p.interested_in, ARRAY['male', 'female']) AS interested_in
     FROM users u
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.latitude IS NOT NULL AND u.longitude IS NOT NULL`
  );

  if (result.rows.length === 0) return 0;

  const operations = result.rows.flatMap((row) => [
    { index: { _index: 'users', _id: row.id } },
    {
      id: row.id,
      name: row.name,
      gender: row.gender,
      age: row.age,
      location: { lat: row.latitude, lon: row.longitude },
      last_active: row.last_active,
      show_me: row.show_me,
      interested_in: row.interested_in,
    },
  ]);

  // refresh: true so the very next discovery query sees these documents; without
  // it the index is only searchable after the default 1s refresh interval, which
  // is exactly the window the screenshot harness hits.
  const response = await elasticsearch.bulk({ refresh: true, operations });
  if (response.errors) {
    const firstError = response.items.find((item) => item.index?.error)?.index?.error;
    console.error('Elasticsearch backfill had errors:', firstError);
  }

  return result.rows.length;
}

/**
 * Initializes the Elasticsearch 'users' index with appropriate mappings, then
 * backfills it from PostgreSQL.
 * Creates geo_point field for location-based queries and keyword fields for filtering.
 * Called once at server startup to ensure the index exists with correct schema.
 * @returns Promise that resolves when initialization is complete
 */
export async function initElasticsearchIndex(): Promise<void> {
  const indexName = 'users';

  try {
    if (!(await waitForElasticsearch())) {
      console.warn('Elasticsearch never became reachable; discovery will use the PostGIS fallback');
      return;
    }

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

    const indexed = await backfillElasticsearchIndex();
    console.log(`Elasticsearch backfill complete: ${indexed} users indexed`);
  } catch (error) {
    console.error('Error initializing Elasticsearch index:', error);
  }
}

/**
 * Verifies connectivity to all data stores (PostgreSQL, Redis, Elasticsearch).
 * Called at server startup to ensure all required services are available.
 * Throws an error if any connection fails, preventing the server from starting in a broken state.
 * @returns Promise that resolves when all connections are verified
 * @throws Error if any database connection fails
 */
export async function testConnections(): Promise<void> {
  try {
    // Test PostgreSQL
    const pgResult = await pool.query('SELECT NOW()');
    console.log('PostgreSQL connected:', pgResult.rows[0].now);

    // Test Redis
    const redisResult = await redis.ping();
    console.log('Redis connected:', redisResult);

    // Elasticsearch powers discovery only — it is NOT required for auth/CRUD, and
    // it is slow to start. Treat it as non-fatal so a slow/absent ES never blocks
    // or crashes the API (login must work immediately).
    try {
      const esResult = await elasticsearch.ping();
      console.log('Elasticsearch connected:', esResult);
    } catch (esError) {
      console.warn('Elasticsearch not reachable yet (discovery degraded):', (esError as Error).message);
    }
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
}
