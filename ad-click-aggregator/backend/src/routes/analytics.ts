/**
 * @fileoverview Analytics API routes for querying aggregated click data.
 * Provides endpoints for time-series queries, campaign summaries,
 * and real-time statistics. Supports flexible grouping and filtering.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryAggregates, getCampaignSummary, getRealTimeStats } from '../services/aggregation.js';
import { getRealTimeGlobalClicks, getRealTimeCampaignClicks, getRealTimeAdClicks } from '../services/redis.js';

const router = Router();

/**
 * Zod validation schema for aggregate query parameters.
 * Supports time range, entity filters, and grouping options.
 */
const aggregateQuerySchema = z.object({
  campaign_id: z.string().optional(),
  advertiser_id: z.string().optional(),
  ad_id: z.string().optional(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  group_by: z.string().optional(), // comma-separated: "hour,country,device_type"
  granularity: z.enum(['minute', 'hour', 'day']).optional(),
});

/**
 * GET /api/v1/analytics/aggregate
 * Queries pre-aggregated click data with flexible filtering and grouping.
 * Supports minute/hour/day granularity and country/device breakdowns.
 *
 * @query start_time - ISO datetime string for range start
 * @query end_time - ISO datetime string for range end
 * @query granularity - Time bucket size: minute, hour, or day
 * @query group_by - Comma-separated dimensions: country, device_type
 */
router.get('/aggregate', async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = aggregateQuerySchema.safeParse(req.query);

    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { group_by, start_time, end_time, ...rest } = validation.data;

    const params = {
      ...rest,
      start_time: new Date(start_time),
      end_time: new Date(end_time),
      group_by: group_by?.split(',').filter((g) => ['hour', 'day', 'country', 'device_type'].includes(g)) as
        | ('hour' | 'day' | 'country' | 'device_type')[]
        | undefined,
    };

    const result = await queryAggregates(params);
    res.json(result);
  } catch (error) {
    console.error('Error querying aggregates:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/analytics/campaign/:campaignId/summary
 * Returns comprehensive statistics for a specific campaign.
 * Includes totals, fraud metrics, and top countries/devices.
 *
 * @param campaignId - Campaign identifier
 * @query start_time - ISO datetime string for range start
 * @query end_time - ISO datetime string for range end
 */
router.get('/campaign/:campaignId/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const { campaignId } = req.params;
    const { start_time, end_time } = req.query;

    if (!start_time || !end_time) {
      res.status(400).json({
        error: 'start_time and end_time are required query parameters',
      });
      return;
    }

    const result = await getCampaignSummary(
      String(campaignId),
      new Date(String(start_time)),
      new Date(String(end_time))
    );

    res.json(result);
  } catch (error) {
    console.error('Error getting campaign summary:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/analytics/realtime
 * Returns click statistics from the last N minutes (from PostgreSQL).
 * Useful for dashboard time-series charts.
 *
 * @query minutes - Lookback period in minutes (1-1440, default: 60)
 */
router.get('/realtime', async (req: Request, res: Response): Promise<void> => {
  try {
    const minutes = parseInt((req.query.minutes as string) || '60', 10);

    if (minutes < 1 || minutes > 1440) {
      res.status(400).json({
        error: 'minutes must be between 1 and 1440',
      });
      return;
    }

    const result = await getRealTimeStats(minutes);
    res.json(result);
  } catch (error) {
    console.error('Error getting real-time stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/analytics/realtime/global
 * Returns global real-time click counts directly from Redis.
 * Fastest option for live dashboards showing system-wide metrics.
 */
router.get('/realtime/global', async (_req: Request, res: Response): Promise<void> => {
  try {
    const clicks = await getRealTimeGlobalClicks();
    res.json({ clicks });
  } catch (error) {
    console.error('Error getting real-time global clicks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/analytics/realtime/campaign/:campaignId
 * Returns real-time click counts for a specific campaign from Redis.
 *
 * @param campaignId - Campaign identifier
 */
router.get('/realtime/campaign/:campaignId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { campaignId } = req.params;
    const clicks = await getRealTimeCampaignClicks(String(campaignId));
    res.json({ campaign_id: campaignId, clicks });
  } catch (error) {
    console.error('Error getting real-time campaign clicks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/analytics/realtime/ad/:adId
 * Returns real-time click counts for a specific ad from Redis.
 *
 * @param adId - Advertisement identifier
 */
router.get('/realtime/ad/:adId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { adId } = req.params;
    const clicks = await getRealTimeAdClicks(String(adId));
    res.json({ ad_id: adId, clicks });
  } catch (error) {
    console.error('Error getting real-time ad clicks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
