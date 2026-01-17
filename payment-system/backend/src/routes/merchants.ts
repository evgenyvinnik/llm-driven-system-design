import { Router } from 'express';
import type { Request, Response } from 'express';
import { MerchantService } from '../services/merchant.service.js';

const router = Router();
const merchantService = new MerchantService();

/**
 * Create a new merchant (public endpoint for signup)
 * POST /api/v1/merchants
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, email, default_currency } = req.body;

    if (!name || !email) {
      res.status(400).json({ error: 'Name and email are required' });
      return;
    }

    // Check if email already exists
    const existing = await merchantService.getMerchantByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const { merchant, apiKey } = await merchantService.createMerchant(
      name,
      email,
      default_currency || 'USD'
    );

    res.status(201).json({
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      default_currency: merchant.default_currency,
      api_key: apiKey, // Only returned on creation!
      webhook_secret: merchant.webhook_secret,
      created_at: merchant.created_at,
    });
  } catch (error) {
    console.error('Create merchant error:', error);
    res.status(500).json({ error: 'Failed to create merchant' });
  }
});

/**
 * Get current merchant profile
 * GET /api/v1/merchants/me
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const balance = await merchantService.getMerchantBalance(req.merchant.id);

    res.json({
      id: req.merchant.id,
      name: req.merchant.name,
      email: req.merchant.email,
      default_currency: req.merchant.default_currency,
      webhook_url: req.merchant.webhook_url,
      status: req.merchant.status,
      balance,
      created_at: req.merchant.created_at,
    });
  } catch (error) {
    console.error('Get merchant profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * Update webhook URL
 * PATCH /api/v1/merchants/me/webhook
 */
router.patch('/me/webhook', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { webhook_url } = req.body;

    if (!webhook_url) {
      res.status(400).json({ error: 'Webhook URL is required' });
      return;
    }

    const updated = await merchantService.updateWebhookUrl(req.merchant.id, webhook_url);

    res.json({
      webhook_url: updated.webhook_url,
    });
  } catch (error) {
    console.error('Update webhook error:', error);
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

/**
 * Rotate API key
 * POST /api/v1/merchants/me/rotate-key
 */
router.post('/me/rotate-key', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { apiKey } = await merchantService.rotateApiKey(req.merchant.id);

    res.json({
      api_key: apiKey,
      message: 'API key rotated successfully. Old key is now invalid.',
    });
  } catch (error) {
    console.error('Rotate API key error:', error);
    res.status(500).json({ error: 'Failed to rotate API key' });
  }
});

/**
 * Get dashboard statistics
 * GET /api/v1/merchants/me/stats
 */
router.get('/me/stats', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Default to last 30 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    if (req.query.start_date) {
      startDate.setTime(new Date(req.query.start_date as string).getTime());
    }
    if (req.query.end_date) {
      endDate.setTime(new Date(req.query.end_date as string).getTime());
    }

    const stats = await merchantService.getDashboardStats(req.merchant.id, startDate, endDate);

    res.json(stats);
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

/**
 * Get volume over time (for charts)
 * GET /api/v1/merchants/me/volume
 */
router.get('/me/volume', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Default to last 30 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    if (req.query.start_date) {
      startDate.setTime(new Date(req.query.start_date as string).getTime());
    }
    if (req.query.end_date) {
      endDate.setTime(new Date(req.query.end_date as string).getTime());
    }

    const granularity = (req.query.granularity as 'hour' | 'day' | 'week') || 'day';

    const data = await merchantService.getVolumeOverTime(
      req.merchant.id,
      startDate,
      endDate,
      granularity
    );

    res.json({ data });
  } catch (error) {
    console.error('Get volume error:', error);
    res.status(500).json({ error: 'Failed to get volume data' });
  }
});

export default router;
