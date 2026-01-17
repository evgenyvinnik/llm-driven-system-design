import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { processClickEvent, processBatchClickEvents } from '../services/click-ingestion.js';

const router = Router();

// Validation schema for click events
const clickEventSchema = z.object({
  click_id: z.string().optional(),
  ad_id: z.string().min(1, 'ad_id is required'),
  campaign_id: z.string().min(1, 'campaign_id is required'),
  advertiser_id: z.string().min(1, 'advertiser_id is required'),
  user_id: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  device_type: z.enum(['desktop', 'mobile', 'tablet']).optional(),
  os: z.string().optional(),
  browser: z.string().optional(),
  country: z.string().max(3).optional(),
  region: z.string().optional(),
  ip_hash: z.string().optional(),
});

const batchClickEventSchema = z.object({
  clicks: z.array(clickEventSchema).min(1).max(1000),
});

/**
 * POST /api/v1/clicks
 * Record a single click event
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = clickEventSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    // Extract IP hash from request if not provided
    const clickData = {
      ...validation.data,
      ip_hash: validation.data.ip_hash || hashIp(req.ip || req.socket.remoteAddress || 'unknown'),
    };

    const result = await processClickEvent(clickData);

    res.status(result.is_duplicate ? 200 : 202).json(result);
  } catch (error) {
    console.error('Error processing click:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/clicks/batch
 * Record multiple click events in a single request
 */
router.post('/batch', async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = batchClickEventSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const results = await processBatchClickEvents(validation.data.clicks);

    const successCount = results.filter((r) => r.success && !r.is_duplicate).length;
    const duplicateCount = results.filter((r) => r.is_duplicate).length;
    const fraudCount = results.filter((r) => r.is_fraudulent).length;
    const errorCount = results.filter((r) => !r.success).length;

    res.status(202).json({
      processed: results.length,
      success_count: successCount,
      duplicate_count: duplicateCount,
      fraud_count: fraudCount,
      error_count: errorCount,
      results,
    });
  } catch (error) {
    console.error('Error processing batch clicks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Simple hash function for IP addresses (for demo purposes)
 * In production, use a proper cryptographic hash
 */
function hashIp(ip: string): string {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

export default router;
