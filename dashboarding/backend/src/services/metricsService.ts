/**
 * @fileoverview Metrics ingestion and definition management service.
 *
 * Handles high-throughput metric data ingestion into TimescaleDB with
 * multi-layer caching for metric IDs. Provides functions to query and
 * explore metric definitions and their tags.
 *
 * WHY ingestion metrics enable capacity planning:
 * Ingestion metrics provide visibility into the data flow rate, enabling:
 * 1. Capacity planning: Track points/second to predict storage growth
 * 2. Anomaly detection: Sudden drops indicate data source failures
 * 3. Rate limiting: Know when to throttle or scale ingestion workers
 * 4. Cost forecasting: Storage costs directly correlate with ingestion rate
 *
 * Key metrics tracked:
 * - ingest_points_total: Total data points ingested (for throughput)
 * - ingest_requests_total: API call count (for load patterns)
 * - ingest_latency_seconds: Time to ingest batches (for performance)
 */

import pool from '../db/pool.js';
import redis from '../db/redis.js';
import logger from '../shared/logger.js';
import { metricsIngestBreaker, withCircuitBreaker, emptyQueryResult } from '../shared/circuitBreaker.js';
import { ingestPointsTotal, ingestRequestsTotal, ingestLatency } from '../shared/metrics.js';
import type { MetricDataPoint, MetricDefinition } from '../types/index.js';

/**
 * In-memory cache for metric definition IDs.
 * Used as first-level cache before Redis for maximum ingestion throughput.
 */
const metricIdCache = new Map<string, number>();

/**
 * Generates a unique cache key for a metric name and tag combination.
 *
 * @param name - The metric name (e.g., "cpu.usage")
 * @param tags - Key-value pairs of metric tags (e.g., { host: "server1" })
 * @returns A deterministic cache key string with sorted tags
 */
function getCacheKey(name: string, tags: Record<string, string>): string {
  const sortedTags = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join(',');
  return `${name}:{${sortedTags}}`;
}

/**
 * Retrieves or creates a metric definition ID for a given metric name and tags.
 *
 * Uses a three-tier caching strategy:
 * 1. In-memory Map cache (fastest, per-process)
 * 2. Redis cache (shared across instances, 1 hour TTL)
 * 3. Database upsert with ON CONFLICT (source of truth)
 *
 * This function is critical for high-throughput ingestion as it avoids
 * repeated database lookups for the same metric definitions.
 *
 * @param name - The metric name
 * @param tags - The metric's tag key-value pairs
 * @returns The numeric metric definition ID
 */
export async function getOrCreateMetricId(
  name: string,
  tags: Record<string, string>
): Promise<number> {
  const cacheKey = getCacheKey(name, tags);

  // Check in-memory cache
  if (metricIdCache.has(cacheKey)) {
    return metricIdCache.get(cacheKey)!;
  }

  // Check Redis cache
  try {
    const cachedId = await redis.get(`metric:${cacheKey}`);
    if (cachedId) {
      const id = parseInt(cachedId);
      metricIdCache.set(cacheKey, id);
      return id;
    }
  } catch (error) {
    // Redis failure - continue to database
    logger.warn({ error, cacheKey }, 'Redis cache lookup failed');
  }

  // Query or insert into database
  const result = await pool.query<MetricDefinition>(
    `INSERT INTO metric_definitions (name, tags)
     VALUES ($1, $2)
     ON CONFLICT (name, tags) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, JSON.stringify(tags)]
  );

  const id = result.rows[0].id;

  // Cache the result
  metricIdCache.set(cacheKey, id);
  try {
    await redis.set(`metric:${cacheKey}`, id.toString(), 'EX', 3600);
  } catch (error) {
    // Redis failure - log but don't fail the operation
    logger.warn({ error, cacheKey }, 'Redis cache set failed');
  }

  return id;
}

/**
 * Ingests an array of metric data points into TimescaleDB.
 *
 * Efficiently batch-inserts metrics using PostgreSQL's unnest function.
 * Each data point is first resolved to a metric_id via getOrCreateMetricId,
 * then all points are inserted in a single query for optimal performance.
 *
 * Tracks ingestion metrics for capacity planning and monitoring:
 * - Total points ingested
 * - Request count
 * - Latency histogram
 *
 * @param dataPoints - Array of metric data points to ingest
 * @returns The number of data points successfully ingested
 */
export async function ingestMetrics(dataPoints: MetricDataPoint[]): Promise<number> {
  if (dataPoints.length === 0) return 0;

  const startTime = Date.now();

  try {
    // Get or create metric IDs for all data points
    const enrichedPoints = await Promise.all(
      dataPoints.map(async (dp) => ({
        ...dp,
        metric_id: await getOrCreateMetricId(dp.name, dp.tags),
      }))
    );

    // Batch insert using COPY-like approach with unnest
    const times = enrichedPoints.map((p) => new Date(p.timestamp));
    const metricIds = enrichedPoints.map((p) => p.metric_id);
    const values = enrichedPoints.map((p) => p.value);

    // Use circuit breaker for database insert
    await withCircuitBreaker(
      metricsIngestBreaker,
      `INSERT INTO metrics (time, metric_id, value)
       SELECT * FROM unnest($1::timestamptz[], $2::integer[], $3::double precision[])`,
      [times, metricIds, values],
      emptyQueryResult()
    );

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    ingestPointsTotal.inc(enrichedPoints.length);
    ingestRequestsTotal.inc({ status: 'success' });
    ingestLatency.observe(duration);

    logger.debug({
      points: enrichedPoints.length,
      duration_ms: Date.now() - startTime,
    }, 'Metrics ingested');

    return enrichedPoints.length;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    ingestRequestsTotal.inc({ status: 'error' });
    ingestLatency.observe(duration);

    logger.error({ error, pointCount: dataPoints.length }, 'Metrics ingestion failed');
    throw error;
  }
}

/**
 * Retrieves metric definitions matching the specified criteria.
 *
 * @param name - Optional metric name to filter by (exact match)
 * @param tags - Optional tags to filter by (uses JSONB containment)
 * @returns Array of matching metric definitions
 */
export async function getMetricDefinitions(
  name?: string,
  tags?: Record<string, string>
): Promise<MetricDefinition[]> {
  let query = 'SELECT id, name, tags, created_at FROM metric_definitions WHERE 1=1';
  const params: unknown[] = [];

  if (name) {
    params.push(name);
    query += ` AND name = $${params.length}`;
  }

  if (tags && Object.keys(tags).length > 0) {
    params.push(JSON.stringify(tags));
    query += ` AND tags @> $${params.length}::jsonb`;
  }

  query += ' ORDER BY name, created_at';

  const result = await pool.query<MetricDefinition>(query, params);
  return result.rows;
}

/**
 * Retrieves all unique metric names in the system.
 *
 * @returns Array of distinct metric names, sorted alphabetically
 */
export async function getMetricNames(): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    'SELECT DISTINCT name FROM metric_definitions ORDER BY name'
  );
  return result.rows.map((r) => r.name);
}

/**
 * Retrieves all unique tag keys used across metric definitions.
 *
 * @param metricName - Optional metric name to filter tag keys by
 * @returns Array of unique tag key names
 */
export async function getTagKeys(metricName?: string): Promise<string[]> {
  let query = `
    SELECT DISTINCT jsonb_object_keys(tags) as key
    FROM metric_definitions
  `;

  const params: unknown[] = [];
  if (metricName) {
    params.push(metricName);
    query += ` WHERE name = $1`;
  }

  query += ' ORDER BY key';

  const result = await pool.query<{ key: string }>(query, params);
  return result.rows.map((r) => r.key);
}

/**
 * Retrieves all unique values for a specific tag key.
 *
 * @param tagKey - The tag key to get values for
 * @param metricName - Optional metric name to filter by
 * @returns Array of unique tag values for the specified key
 */
export async function getTagValues(
  tagKey: string,
  metricName?: string
): Promise<string[]> {
  let query = `
    SELECT DISTINCT tags->$1 as value
    FROM metric_definitions
    WHERE tags ? $1
  `;

  const params: unknown[] = [tagKey];
  if (metricName) {
    params.push(metricName);
    query += ` AND name = $${params.length}`;
  }

  query += ' ORDER BY value';

  const result = await pool.query<{ value: string }>(query, params);
  return result.rows.map((r) => r.value).filter(Boolean);
}

/**
 * Clears the in-memory metric ID cache.
 * Useful for testing or when metric definitions are bulk-modified.
 */
export function clearMetricIdCache(): void {
  metricIdCache.clear();
  logger.info({ size: metricIdCache.size }, 'Metric ID cache cleared');
}

/**
 * Gets statistics about the metric ID cache.
 *
 * @returns Object with cache statistics
 */
export function getMetricIdCacheStats(): { size: number; entries: string[] } {
  return {
    size: metricIdCache.size,
    entries: Array.from(metricIdCache.keys()).slice(0, 100), // First 100 for debugging
  };
}
