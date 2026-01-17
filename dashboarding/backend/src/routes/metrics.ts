/**
 * @fileoverview Metrics API routes for ingestion and querying.
 *
 * Exposes REST endpoints for:
 * - High-throughput metric data ingestion (POST /ingest)
 * - Time-series queries with aggregation (POST /query)
 * - Latest value and statistics retrieval
 * - Metric metadata exploration (names, tags, definitions)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ingestMetrics, getMetricDefinitions, getMetricNames, getTagKeys, getTagValues } from '../services/metricsService.js';
import { queryMetrics, getLatestValue, getMetricStats } from '../services/queryService.js';
import logger from '../shared/logger.js';

const router = Router();

/**
 * Zod schema for validating individual metric data points during ingestion.
 */
const MetricDataPointSchema = z.object({
  name: z.string().min(1).max(255),
  value: z.number(),
  tags: z.record(z.string()).default({}),
  timestamp: z.number().optional(),
});

/**
 * Zod schema for validating bulk ingestion requests.
 * Accepts 1-10,000 metrics per request for batch efficiency.
 */
const IngestRequestSchema = z.object({
  metrics: z.array(MetricDataPointSchema).min(1).max(10000),
});

/**
 * POST /ingest
 * Ingests an array of metric data points into the time-series database.
 * Adds current timestamp to any metrics missing a timestamp.
 *
 * @body {metrics: MetricDataPoint[]} - Array of metric data points
 * @returns {accepted: number} - Count of successfully ingested metrics
 */
router.post('/ingest', async (req: Request, res: Response) => {
  try {
    const validation = IngestRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const { metrics } = validation.data;

    // Add timestamp if not provided
    const now = Date.now();
    const enrichedMetrics = metrics.map((m) => ({
      ...m,
      timestamp: m.timestamp || now,
    }));

    const count = await ingestMetrics(enrichedMetrics);

    res.json({ accepted: count });
  } catch (error) {
    logger.error({ error }, 'Ingestion error');
    res.status(500).json({ error: 'Failed to ingest metrics' });
  }
});

/**
 * Zod schema for validating time-series query requests.
 */
const QueryRequestSchema = z.object({
  metric_name: z.string().min(1),
  tags: z.record(z.string()).optional(),
  start_time: z.string().or(z.number()),
  end_time: z.string().or(z.number()),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).optional(),
  interval: z.string().optional(),
  group_by: z.array(z.string()).optional(),
});

/**
 * POST /query
 * Executes a time-series query with aggregation and optional grouping.
 *
 * @body {metric_name, start_time, end_time, aggregation?, interval?, group_by?}
 * @returns {results: QueryResult[]} - Array of time-series results
 */
router.post('/query', async (req: Request, res: Response) => {
  try {
    const validation = QueryRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const { metric_name, tags, start_time, end_time, aggregation, interval, group_by } =
      validation.data;

    const results = await queryMetrics({
      metric_name,
      tags,
      start_time: new Date(start_time),
      end_time: new Date(end_time),
      aggregation,
      interval,
      group_by,
    });

    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'Query error');
    res.status(500).json({ error: 'Failed to query metrics' });
  }
});

/**
 * GET /latest/:metricName
 * Retrieves the most recent value for a specific metric.
 *
 * @param metricName - The metric name to query
 * @query tags - Optional JSON-encoded tag filters
 * @returns {value, time} - Latest value and its timestamp
 */
router.get('/latest/:metricName', async (req: Request, res: Response) => {
  try {
    const { metricName } = req.params;
    const tags = req.query.tags ? JSON.parse(req.query.tags as string) : undefined;

    const result = await getLatestValue(metricName, tags);

    if (!result) {
      return res.status(404).json({ error: 'Metric not found' });
    }

    res.json(result);
  } catch (error) {
    logger.error({ error, metricName: req.params.metricName }, 'Get latest error');
    res.status(500).json({ error: 'Failed to get latest value' });
  }
});

/**
 * GET /stats/:metricName
 * Calculates aggregate statistics for a metric over a time range.
 *
 * @param metricName - The metric name to analyze
 * @query start_time - Start of time range (default: 1 hour ago)
 * @query end_time - End of time range (default: now)
 * @query tags - Optional JSON-encoded tag filters
 * @returns {min, max, avg, count} - Aggregate statistics
 */
router.get('/stats/:metricName', async (req: Request, res: Response) => {
  try {
    const { metricName } = req.params;
    const startTime = req.query.start_time
      ? new Date(req.query.start_time as string)
      : new Date(Date.now() - 60 * 60 * 1000); // Default: last hour
    const endTime = req.query.end_time
      ? new Date(req.query.end_time as string)
      : new Date();
    const tags = req.query.tags ? JSON.parse(req.query.tags as string) : undefined;

    const result = await getMetricStats(metricName, startTime, endTime, tags);

    if (!result) {
      return res.status(404).json({ error: 'Metric not found or no data' });
    }

    res.json(result);
  } catch (error) {
    logger.error({ error, metricName: req.params.metricName }, 'Get stats error');
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

/**
 * GET /definitions
 * Retrieves metric definitions (metric name + tag combinations).
 *
 * @query name - Optional metric name filter
 * @query tags - Optional JSON-encoded tag filter
 * @returns {definitions: MetricDefinition[]} - Array of metric definitions
 */
router.get('/definitions', async (req: Request, res: Response) => {
  try {
    const name = req.query.name as string | undefined;
    const tags = req.query.tags ? JSON.parse(req.query.tags as string) : undefined;

    const definitions = await getMetricDefinitions(name, tags);

    res.json({ definitions });
  } catch (error) {
    logger.error({ error }, 'Get definitions error');
    res.status(500).json({ error: 'Failed to get definitions' });
  }
});

/**
 * GET /names
 * Retrieves all unique metric names in the system.
 *
 * @returns {names: string[]} - Array of metric names
 */
router.get('/names', async (req: Request, res: Response) => {
  try {
    const names = await getMetricNames();
    res.json({ names });
  } catch (error) {
    logger.error({ error }, 'Get names error');
    res.status(500).json({ error: 'Failed to get metric names' });
  }
});

/**
 * GET /tags/keys
 * Retrieves all unique tag keys across metric definitions.
 *
 * @query metric_name - Optional filter to scope to a specific metric
 * @returns {keys: string[]} - Array of tag key names
 */
router.get('/tags/keys', async (req: Request, res: Response) => {
  try {
    const metricName = req.query.metric_name as string | undefined;
    const keys = await getTagKeys(metricName);
    res.json({ keys });
  } catch (error) {
    logger.error({ error }, 'Get tag keys error');
    res.status(500).json({ error: 'Failed to get tag keys' });
  }
});

/**
 * GET /tags/values/:key
 * Retrieves all unique values for a specific tag key.
 *
 * @param key - The tag key to get values for
 * @query metric_name - Optional filter to scope to a specific metric
 * @returns {values: string[]} - Array of tag values
 */
router.get('/tags/values/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const metricName = req.query.metric_name as string | undefined;
    const values = await getTagValues(key, metricName);
    res.json({ values });
  } catch (error) {
    logger.error({ error, key: req.params.key }, 'Get tag values error');
    res.status(500).json({ error: 'Failed to get tag values' });
  }
});

export default router;
