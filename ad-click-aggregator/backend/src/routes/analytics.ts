import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryAggregates, getCampaignSummary, getRealTimeStats } from '../services/aggregation.js';
import { getRealTimeGlobalClicks, getRealTimeCampaignClicks, getRealTimeAdClicks } from '../services/redis.js';

const router = Router();

// Validation schema for aggregate queries
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
 * Query aggregated click data
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
 * Get summary statistics for a campaign
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
      campaignId,
      new Date(start_time as string),
      new Date(end_time as string)
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
 * Get real-time click statistics from the last N minutes
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
 * Get real-time global click counts from Redis
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
 * Get real-time click counts for a specific campaign
 */
router.get('/realtime/campaign/:campaignId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { campaignId } = req.params;
    const clicks = await getRealTimeCampaignClicks(campaignId);
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
 * Get real-time click counts for a specific ad
 */
router.get('/realtime/ad/:adId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { adId } = req.params;
    const clicks = await getRealTimeAdClicks(adId);
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
