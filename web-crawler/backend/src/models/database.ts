/**
 * @fileoverview PostgreSQL database connection and schema initialization.
 *
 * This module sets up the PostgreSQL connection pool and defines the database
 * schema for the web crawler. PostgreSQL serves as the primary persistent store
 * for all crawler data that needs durability and complex querying.
 *
 * PostgreSQL was chosen over alternatives because:
 * - ACID guarantees for URL state transitions (pending → in_progress → completed)
 * - Efficient B-tree indexes for priority-based queue operations
 * - Rich query capabilities for analytics and reporting
 * - Proven reliability for long-running crawl operations
 *
 * The schema is designed for a distributed crawler with multiple workers
 * accessing the same frontier concurrently.
 *
 * @module models/database
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * PostgreSQL connection pool instance.
 *
 * A connection pool is used instead of individual connections because:
 * 1. Connection establishment is expensive (TCP handshake, auth, SSL)
 * 2. Workers make frequent, short-lived queries to the frontier
 * 3. Pool manages connection lifecycle and handles reconnection
 *
 * Pool settings are tuned for a web crawler workload:
 * - max: 20 connections supports multiple workers querying concurrently
 * - idleTimeoutMillis: 30s closes unused connections to free DB resources
 * - connectionTimeoutMillis: 2s fails fast if DB is unavailable
 *
 * @example
 * ```typescript
 * import { pool } from './models/database';
 *
 * // Execute a query using the pool
 * const result = await pool.query('SELECT * FROM url_frontier WHERE status = $1', ['pending']);
 *
 * // For transactions, acquire a dedicated client
 * const client = await pool.connect();
 * try {
 *   await client.query('BEGIN');
 *   // ... transaction operations
 *   await client.query('COMMIT');
 * } finally {
 *   client.release();
 * }
 * ```
 */
export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Global error handler for idle pool clients.
 *
 * This catches unexpected errors on idle connections (e.g., DB server restart,
 * network issues). Without this handler, such errors would crash the process.
 * The pool will automatically remove the errored client and create a new one.
 */
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

/**
 * Initializes the database schema for the web crawler.
 *
 * Creates all tables and indexes required for crawler operation if they don't exist.
 * This function is idempotent - safe to call multiple times (uses IF NOT EXISTS).
 *
 * **Tables created:**
 *
 * 1. **domains** - Per-domain metadata
 *    - Caches robots.txt content to avoid refetching
 *    - Stores custom crawl delays from robots.txt Crawl-delay directive
 *    - Tracks page counts per domain for monitoring
 *
 * 2. **url_frontier** - The URL queue (heart of the crawler)
 *    - Stores URLs to be crawled with their priority and status
 *    - url_hash (SHA-256) enables fast deduplication lookups
 *    - Compound index on (domain, status, priority, scheduled_at) optimizes
 *      the "get next URL for domain X" query pattern
 *
 * 3. **crawled_pages** - Results of successful crawls
 *    - Stores metadata: status code, content type, page title
 *    - content_hash enables cross-URL duplicate detection
 *    - crawl_duration_ms for performance monitoring
 *
 * 4. **crawl_stats** - Per-worker statistics
 *    - Enables monitoring dashboard to show crawler throughput
 *    - Tracks pages crawled, failures, bytes downloaded per worker
 *
 * 5. **seed_urls** - Initial URLs to start crawling
 *    - Admin can add/remove seed URLs via API
 *    - is_active flag allows disabling seeds without deletion
 *
 * @returns Promise that resolves when schema is created
 * @throws Error if database connection or schema creation fails
 *
 * @example
 * ```typescript
 * import { initDatabase } from './models/database';
 *
 * // Call during application startup
 * await initDatabase();
 * console.log('Database ready');
 * ```
 */
export async function initDatabase() {
  const client = await pool.connect();
  try {
    // Create tables
    await client.query(`
      -- Domains table: stores robots.txt info and crawl settings per domain
      CREATE TABLE IF NOT EXISTS domains (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL UNIQUE,
        robots_txt TEXT,
        robots_fetched_at TIMESTAMP,
        crawl_delay FLOAT DEFAULT 1.0,
        page_count INTEGER DEFAULT 0,
        is_allowed BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);

      -- URL frontier: the queue of URLs to crawl
      CREATE TABLE IF NOT EXISTS url_frontier (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        url_hash VARCHAR(64) NOT NULL UNIQUE,
        domain VARCHAR(255) NOT NULL,
        priority INTEGER DEFAULT 1,
        depth INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        scheduled_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_frontier_status ON url_frontier(status);
      CREATE INDEX IF NOT EXISTS idx_frontier_domain ON url_frontier(domain);
      CREATE INDEX IF NOT EXISTS idx_frontier_priority ON url_frontier(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_frontier_scheduled ON url_frontier(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_frontier_domain_status_priority
        ON url_frontier(domain, status, priority DESC, scheduled_at);

      -- Crawled pages: metadata about pages we've crawled
      CREATE TABLE IF NOT EXISTS crawled_pages (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        url_hash VARCHAR(64) NOT NULL UNIQUE,
        domain VARCHAR(255) NOT NULL,
        status_code INTEGER,
        content_type VARCHAR(100),
        content_length INTEGER,
        content_hash VARCHAR(64),
        title TEXT,
        description TEXT,
        links_count INTEGER DEFAULT 0,
        crawled_at TIMESTAMP DEFAULT NOW(),
        crawl_duration_ms INTEGER,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_crawled_url_hash ON crawled_pages(url_hash);
      CREATE INDEX IF NOT EXISTS idx_crawled_domain ON crawled_pages(domain);
      CREATE INDEX IF NOT EXISTS idx_crawled_at ON crawled_pages(crawled_at);

      -- Crawl statistics: aggregated stats for monitoring
      CREATE TABLE IF NOT EXISTS crawl_stats (
        id SERIAL PRIMARY KEY,
        worker_id VARCHAR(50) NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        pages_crawled INTEGER DEFAULT 0,
        pages_failed INTEGER DEFAULT 0,
        bytes_downloaded BIGINT DEFAULT 0,
        links_discovered INTEGER DEFAULT 0,
        duplicates_skipped INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_stats_worker ON crawl_stats(worker_id);
      CREATE INDEX IF NOT EXISTS idx_stats_timestamp ON crawl_stats(timestamp);

      -- Seed URLs table for initial crawl starting points
      CREATE TABLE IF NOT EXISTS seed_urls (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        priority INTEGER DEFAULT 2,
        added_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true
      );
    `);

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

/**
 * Closes all database connections in the pool.
 *
 * Should be called during graceful shutdown to:
 * 1. Complete any in-flight queries
 * 2. Release database connections back to the server
 * 3. Allow the process to exit cleanly
 *
 * After calling this, the pool cannot be used for new queries.
 *
 * @returns Promise that resolves when all connections are closed
 *
 * @example
 * ```typescript
 * import { closeDatabase } from './models/database';
 *
 * // During shutdown
 * process.on('SIGTERM', async () => {
 *   await closeDatabase();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeDatabase() {
  await pool.end();
}
