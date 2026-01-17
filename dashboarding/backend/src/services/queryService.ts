/**
 * @fileoverview Metric query service with intelligent table selection and caching.
 *
 * Provides optimized time-series queries by automatically selecting the
 * appropriate data table (raw, hourly rollup, or daily rollup) based on
 * the requested time range. Implements Redis caching for query results
 * to reduce database load.
 */

import pool from '../db/pool.js';
import redis from '../db/redis.js';
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
 * Generates a unique cache key for a query based on its parameters.
 *
 * @param params - The query parameters
 * @returns A JSON string representing the query for cache lookup
 */
function getCacheKey(params: MetricQueryParams): string {
  return `query:${JSON.stringify(params)}`;
}

/**
 * Executes a time-series query for metrics matching the specified criteria.
 *
 * Automatically selects the optimal data source (raw or rollup tables),
 * applies time bucketing for aggregation, and caches results in Redis.
 * Historical queries (end time > 1 hour ago) are cached for 1 hour,
 * while recent queries have a 10-second cache for near-real-time updates.
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

  // Check cache for historical queries (more than 1 hour old)
  const isHistorical = end_time.getTime() < Date.now() - 60 * 60 * 1000;
  const cacheKey = getCacheKey(params);

  if (isHistorical) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  const table = selectTable({ start: start_time, end: end_time });
  const pgInterval = parseInterval(interval);

  // Build the query
  let query: string;
  const queryParams: unknown[] = [];

  // Get metric definitions that match
  queryParams.push(metric_name);
  let defQuery = `SELECT id, name, tags FROM metric_definitions WHERE name = $1`;

  if (Object.keys(tags).length > 0) {
    queryParams.push(JSON.stringify(tags));
    defQuery += ` AND tags @> $${queryParams.length}::jsonb`;
  }

  const defResult = await pool.query<{ id: number; name: string; tags: Record<string, string> }>(
    defQuery,
    queryParams
  );

  if (defResult.rows.length === 0) {
    return [];
  }

  const metricIds = defResult.rows.map((r) => r.id);
  const metricMap = new Map(defResult.rows.map((r) => [r.id, { name: r.name, tags: r.tags }]));

  // Query the appropriate table
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
    queryParams.length = 0;
    queryParams.push(pgInterval, metricIds, start_time, end_time);
  } else {
    // Rollup data query
    const valueColumn =
      aggregation === 'count' ? 'count' : `${aggregation}_value`;
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
    queryParams.length = 0;
    queryParams.push(pgInterval, metricIds, start_time, end_time);
  }

  const result = await pool.query<{ bucket: Date; metric_id: number; value: number }>(
    query,
    queryParams
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

  // Cache historical results
  if (isHistorical && results.length > 0) {
    await redis.set(cacheKey, JSON.stringify(results), 'EX', 3600);
  } else if (results.length > 0) {
    // Short cache for recent data
    await redis.set(cacheKey, JSON.stringify(results), 'EX', 10);
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
