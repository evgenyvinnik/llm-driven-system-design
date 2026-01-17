import pool from '../db/pool.js';
import redis from '../db/redis.js';
import type { MetricDataPoint, MetricDefinition } from '../types/index.js';

// Cache for metric definitions (metric_name + tags -> id)
const metricIdCache = new Map<string, number>();

function getCacheKey(name: string, tags: Record<string, string>): string {
  const sortedTags = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join(',');
  return `${name}:{${sortedTags}}`;
}

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
  const cachedId = await redis.get(`metric:${cacheKey}`);
  if (cachedId) {
    const id = parseInt(cachedId);
    metricIdCache.set(cacheKey, id);
    return id;
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
  await redis.set(`metric:${cacheKey}`, id.toString(), 'EX', 3600);

  return id;
}

export async function ingestMetrics(dataPoints: MetricDataPoint[]): Promise<number> {
  if (dataPoints.length === 0) return 0;

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

  await pool.query(
    `INSERT INTO metrics (time, metric_id, value)
     SELECT * FROM unnest($1::timestamptz[], $2::integer[], $3::double precision[])`,
    [times, metricIds, values]
  );

  return enrichedPoints.length;
}

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

export async function getMetricNames(): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    'SELECT DISTINCT name FROM metric_definitions ORDER BY name'
  );
  return result.rows.map((r) => r.name);
}

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
