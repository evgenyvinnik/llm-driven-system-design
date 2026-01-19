/**
 * @fileoverview Metric query service with intelligent table selection and caching.
 *
 * Provides optimized time-series queries by automatically selecting the
 * appropriate data table (raw, hourly rollup, or daily rollup) based on
 * the requested time range. Implements Redis caching for query results
 * to reduce database load and circuit breaker for protection against
 * slow or failing database queries.
 *
 * WHY query caching reduces database load:
 * Dashboard panels typically refresh every 10-30 seconds, and multiple users
 * often view the same dashboard. Without caching, each panel refresh
 * triggers a full database query against large time-series tables.
 *
 * Query caching provides:
 * 1. Reduced database load: Identical queries within TTL window share results
 * 2. Improved latency: Cache hits return in <1ms vs 100-500ms for DB queries
 * 3. Better scalability: Cache can handle 10-100x more requests than DB
 * 4. Protection during traffic spikes: Cache absorbs sudden load increases
 *
 * WHY circuit breakers protect against slow queries:
 * Without a circuit breaker, slow database queries accumulate, exhausting
 * connection pools and causing cascading failures. The circuit breaker
 * "trips" after detecting repeated failures, immediately rejecting new
 * requests and allowing the database to recover.
 */

import pool from '../db/pool.js';
import logger from '../shared/logger.js';
import { metricsQueryBreaker, withCircuitBreaker, emptyQueryResult } from '../shared/circuitBreaker.js';
import { generateCacheKey, determineTtl, getOrLoad } from '../shared/cache.js';
import { queryDuration, queryRequestsTotal, cacheOperations } from '../shared/metrics.js';
import type { MetricQueryParams, QueryResult, DataPoint } from '../types/index.js';

/**
 * Represents a time range with start and end dates.
 */
interface TimeRange {
  start: Date;
  end: Date;
}

/**
 * Parses a human-readable interval string to PostgreSQL interval format.
 *
 * @param interval - Interval string like '1m', '5m', '1h', '1d'
 * @returns PostgreSQL-compatible interval string
 *
 * @example
 * parseInterval('5m') // Returns '5 minute'
 * parseInterval('1h') // Returns '1 hour'
 */
function parseInterval(interval: string): string {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return '1 minute';

  const [, num, unit] = match;
  const units: Record<string, string> = {
    s: 'second',
    m: 'minute',
    h: 'hour',
    d: 'day',
  };
  return `${num} ${units[unit]}`;
}

/**
 * Selects the optimal data table based on the query time range.
 *
 * Uses a tiered approach to balance query performance with data granularity:
 * - Raw metrics table for ranges up to 6 hours (full resolution)
 * - Hourly rollups for ranges up to 7 days (reduced storage scan)
 * - Daily rollups for longer ranges (maximum efficiency)
 *
 * @param timeRange - The query time range
 * @returns The table name to query
 */
function selectTable(timeRange: TimeRange): string {
  const diffHours =
    (timeRange.end.getTime() - timeRange.start.getTime()) / (1000 * 60 * 60);

  if (diffHours <= 6) {
    return 'metrics'; // Raw data
  } else if (diffHours <= 24 * 7) {
    return 'metrics_hourly'; // Hourly rollups
  } else {
    return 'metrics_daily'; // Daily rollups
  }
}

/**
 * Executes a time-series query for metrics matching the specified criteria.
 *
 * Automatically selects the optimal data source (raw or rollup tables),
 * applies time bucketing for aggregation, and caches results in Redis.
 * Historical queries (end time > 1 hour ago) are cached for 5 minutes,
 * while recent queries have a 10-second cache for near-real-time updates.
 *
 * Uses circuit breaker protection to prevent cascade failures when the
 * database is slow or unresponsive.
 *
 * @param params - Query parameters including metric name, time range, and aggregation
 * @returns Array of query results, grouped by metric series
 */
export async function queryMetrics(params: MetricQueryParams): Promise<QueryResult[]> {
  const {
    metric_name,
    tags = {},
    start_time,
    end_time,
    aggregation = 'avg',
    interval = '1m',
    group_by = [],
  } = params;

  const startMs = Date.now();
  const table = selectTable({ start: start_time, end: end_time });
  const ttl = determineTtl(end_time);
  const isHistorical = end_time.getTime() < Date.now() - 60 * 60 * 1000;

  // Generate cache key based on query parameters
  const cacheKey = generateCacheKey('query', {
    metric_name,
    tags,
    start_time: start_time.toISOString(),
    end_time: end_time.toISOString(),
    aggregation,
    interval,
    group_by,
  });

  try {
    // Use cache-aside pattern with enhanced caching module
    const results = await getOrLoad<QueryResult[]>(
      cacheKey,
      async () => {
        return executeQuery(params, table);
      },
      ttl
    );

    // Record metrics
    const duration = (Date.now() - startMs) / 1000;
    queryDuration.observe({ cache_hit: 'unknown', table }, duration);
    queryRequestsTotal.inc({ status: 'success', cache_hit: isHistorical ? 'possibly' : 'no' });

    return results;
  } catch (error) {
    queryRequestsTotal.inc({ status: 'error', cache_hit: 'no' });
    logger.error({ error, params }, 'Query execution failed');
    throw error;
  }
}

/**
 * Executes the actual database query with circuit breaker protection.
 *
 * @param params - Query parameters
 * @param table - Target table name
 * @returns Query results
 */
async function executeQuery(params: MetricQueryParams, table: string): Promise<QueryResult[]> {
  const {
    metric_name,
    tags = {},
    start_time,
    end_time,
    aggregation = 'avg',
    interval = '1m',
  } = params;

  const pgInterval = parseInterval(interval);

  // Get metric definitions that match
  const queryParams: unknown[] = [metric_name];
  let defQuery = `SELECT id, name, tags FROM metric_definitions WHERE name = $1`;

  if (Object.keys(tags).length > 0) {
    queryParams.push(JSON.stringify(tags));
    defQuery += ` AND tags @> $${queryParams.length}::jsonb`;
  }

  // Use circuit breaker for definition query
  const defResult = await withCircuitBreaker(
    metricsQueryBreaker,
    defQuery,
    queryParams,
    emptyQueryResult<{ id: number; name: string; tags: Record<string, string> }>()
  );

  if (defResult.rows.length === 0) {
    return [];
  }

  const metricIds = defResult.rows.map((r) => r.id);
  const metricMap = new Map(defResult.rows.map((r) => [r.id, { name: r.name, tags: r.tags }]));

  // Build the query based on table type
  let query: string;
  const dataQueryParams: unknown[] = [];

  if (table === 'metrics') {
    // Raw data query
    query = `
      SELECT
        time_bucket($1::interval, time) AS bucket,
        metric_id,
        ${aggregation}(value) as value
      FROM metrics
      WHERE metric_id = ANY($2)
        AND time >= $3
        AND time <= $4
      GROUP BY bucket, metric_id
      ORDER BY bucket ASC
    `;
    dataQueryParams.push(pgInterval, metricIds, start_time, end_time);
  } else {
    // Rollup data query
    const valueColumn = aggregation === 'count' ? 'count' : `${aggregation}_value`;
    query = `
      SELECT
        time_bucket($1::interval, time) AS bucket,
        metric_id,
        ${aggregation === 'count' ? 'SUM(count)' : `${aggregation.toUpperCase()}(${valueColumn})`} as value
      FROM ${table}
      WHERE metric_id = ANY($2)
        AND time >= $3
        AND time <= $4
      GROUP BY bucket, metric_id
      ORDER BY bucket ASC
    `;
    dataQueryParams.push(pgInterval, metricIds, start_time, end_time);
  }

  // Use circuit breaker for the main data query
  const result = await withCircuitBreaker(
    metricsQueryBreaker,
    query,
    dataQueryParams,
    emptyQueryResult<{ bucket: Date; metric_id: number; value: number }>()
  );

  // Group results by metric
  const resultsByMetric = new Map<number, DataPoint[]>();
  for (const row of result.rows) {
    if (!resultsByMetric.has(row.metric_id)) {
      resultsByMetric.set(row.metric_id, []);
    }
    resultsByMetric.get(row.metric_id)!.push({
      time: row.bucket,
      value: parseFloat(row.value.toString()),
    });
  }

  // Build final results
  const results: QueryResult[] = [];
  for (const [metricId, data] of resultsByMetric) {
    const metricInfo = metricMap.get(metricId);
    if (metricInfo) {
      results.push({
        metric_name: metricInfo.name,
        tags: metricInfo.tags,
        data,
      });
    }
  }

  return results;
}

/**
 * Retrieves the most recent value for a metric.
 *
 * Useful for stat panels and gauges that display current values.
 *
 * @param metricName - The metric name to query
 * @param tags - Optional tags to filter by
 * @returns The latest value and timestamp, or null if no data exists
 */
export async function getLatestValue(
  metricName: string,
  tags?: Record<string, string>
): Promise<{ value: number; time: Date } | null> {
  const queryParams: unknown[] = [metricName];
  let defQuery = `SELECT id FROM metric_definitions WHERE name = $1`;

  if (tags && Object.keys(tags).length > 0) {
    queryParams.push(JSON.stringify(tags));
    defQuery += ` AND tags @> $${queryParams.length}::jsonb`;
  }

  defQuery += ' LIMIT 1';

  const defResult = await pool.query<{ id: number }>(defQuery, queryParams);
  if (defResult.rows.length === 0) return null;

  const metricId = defResult.rows[0].id;

  const result = await pool.query<{ value: number; time: Date }>(
    `SELECT value, time FROM metrics
     WHERE metric_id = $1
     ORDER BY time DESC LIMIT 1`,
    [metricId]
  );

  return result.rows[0] || null;
}

/**
 * Calculates aggregate statistics for a metric over a time range.
 *
 * Computes min, max, avg, and count across all matching data points.
 * Useful for summary panels and alert evaluation.
 *
 * @param metricName - The metric name to analyze
 * @param startTime - Start of the time range
 * @param endTime - End of the time range
 * @param tags - Optional tags to filter by
 * @returns Aggregated statistics, or null if no matching data
 */
export async function getMetricStats(
  metricName: string,
  startTime: Date,
  endTime: Date,
  tags?: Record<string, string>
): Promise<{
  min: number;
  max: number;
  avg: number;
  count: number;
} | null> {
  const queryParams: unknown[] = [metricName];
  let defQuery = `SELECT id FROM metric_definitions WHERE name = $1`;

  if (tags && Object.keys(tags).length > 0) {
    queryParams.push(JSON.stringify(tags));
    defQuery += ` AND tags @> $${queryParams.length}::jsonb`;
  }

  const defResult = await pool.query<{ id: number }>(defQuery, queryParams);
  if (defResult.rows.length === 0) return null;

  const metricIds = defResult.rows.map((r) => r.id);

  const result = await pool.query<{
    min: number;
    max: number;
    avg: number;
    count: string;
  }>(
    `SELECT
      MIN(value) as min,
      MAX(value) as max,
      AVG(value) as avg,
      COUNT(*) as count
     FROM metrics
     WHERE metric_id = ANY($1)
       AND time >= $2
       AND time <= $3`,
    [metricIds, startTime, endTime]
  );

  const row = result.rows[0];
  if (!row || row.count === '0') return null;

  return {
    min: parseFloat(row.min.toString()),
    max: parseFloat(row.max.toString()),
    avg: parseFloat(row.avg.toString()),
    count: parseInt(row.count),
  };
}
