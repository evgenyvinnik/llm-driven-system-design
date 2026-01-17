import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ingestMetrics, getMetricDefinitions, getMetricNames, getTagKeys, getTagValues } from '../services/metricsService.js';
import { queryMetrics, getLatestValue, getMetricStats } from '../services/queryService.js';

const router = Router();

// Schema for metric ingestion
const MetricDataPointSchema = z.object({
  name: z.string().min(1).max(255),
  value: z.number(),
  tags: z.record(z.string()).default({}),
  timestamp: z.number().optional(),
});

const IngestRequestSchema = z.object({
  metrics: z.array(MetricDataPointSchema).min(1).max(10000),
});

// Ingest metrics
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
    console.error('Ingestion error:', error);
    res.status(500).json({ error: 'Failed to ingest metrics' });
  }
});

// Query metrics
const QueryRequestSchema = z.object({
  metric_name: z.string().min(1),
  tags: z.record(z.string()).optional(),
  start_time: z.string().or(z.number()),
  end_time: z.string().or(z.number()),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).optional(),
  interval: z.string().optional(),
  group_by: z.array(z.string()).optional(),
});

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
    console.error('Query error:', error);
    res.status(500).json({ error: 'Failed to query metrics' });
  }
});

// Get latest value for a metric
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
    console.error('Get latest error:', error);
    res.status(500).json({ error: 'Failed to get latest value' });
  }
});

// Get statistics for a metric
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
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// Get metric definitions
router.get('/definitions', async (req: Request, res: Response) => {
  try {
    const name = req.query.name as string | undefined;
    const tags = req.query.tags ? JSON.parse(req.query.tags as string) : undefined;

    const definitions = await getMetricDefinitions(name, tags);

    res.json({ definitions });
  } catch (error) {
    console.error('Get definitions error:', error);
    res.status(500).json({ error: 'Failed to get definitions' });
  }
});

// Get metric names
router.get('/names', async (req: Request, res: Response) => {
  try {
    const names = await getMetricNames();
    res.json({ names });
  } catch (error) {
    console.error('Get names error:', error);
    res.status(500).json({ error: 'Failed to get metric names' });
  }
});

// Get tag keys
router.get('/tags/keys', async (req: Request, res: Response) => {
  try {
    const metricName = req.query.metric_name as string | undefined;
    const keys = await getTagKeys(metricName);
    res.json({ keys });
  } catch (error) {
    console.error('Get tag keys error:', error);
    res.status(500).json({ error: 'Failed to get tag keys' });
  }
});

// Get tag values
router.get('/tags/values/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const metricName = req.query.metric_name as string | undefined;
    const values = await getTagValues(key, metricName);
    res.json({ values });
  } catch (error) {
    console.error('Get tag values error:', error);
    res.status(500).json({ error: 'Failed to get tag values' });
  }
});

export default router;
