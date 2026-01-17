import { Router, Request, Response } from 'express';
import { query } from '../services/database.js';

const router = Router();

/**
 * GET /api/v1/admin/ads
 * List all ads
 */
router.get('/ads', async (_req: Request, res: Response): Promise<void> => {
  try {
    const ads = await query(`
      SELECT a.*, c.name as campaign_name, adv.name as advertiser_name
      FROM ads a
      JOIN campaigns c ON a.campaign_id = c.id
      JOIN advertisers adv ON c.advertiser_id = adv.id
      ORDER BY a.created_at DESC
    `);
    res.json({ ads });
  } catch (error) {
    console.error('Error listing ads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/admin/campaigns
 * List all campaigns
 */
router.get('/campaigns', async (_req: Request, res: Response): Promise<void> => {
  try {
    const campaigns = await query(`
      SELECT c.*, adv.name as advertiser_name
      FROM campaigns c
      JOIN advertisers adv ON c.advertiser_id = adv.id
      ORDER BY c.created_at DESC
    `);
    res.json({ campaigns });
  } catch (error) {
    console.error('Error listing campaigns:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/admin/advertisers
 * List all advertisers
 */
router.get('/advertisers', async (_req: Request, res: Response): Promise<void> => {
  try {
    const advertisers = await query(`
      SELECT * FROM advertisers ORDER BY created_at DESC
    `);
    res.json({ advertisers });
  } catch (error) {
    console.error('Error listing advertisers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/admin/stats
 * Get overall system statistics
 */
router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [clickCount] = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM click_events'
    );
    const [fraudCount] = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM click_events WHERE is_fraudulent = true'
    );
    const [adCount] = await query<{ count: string }>('SELECT COUNT(*) as count FROM ads');
    const [campaignCount] = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM campaigns'
    );
    const [advertiserCount] = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM advertisers'
    );

    // Get clicks in last 24 hours
    const [last24h] = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM click_events WHERE timestamp > NOW() - INTERVAL '24 hours'"
    );

    // Get clicks in last hour
    const [lastHour] = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM click_events WHERE timestamp > NOW() - INTERVAL '1 hour'"
    );

    res.json({
      total_clicks: parseInt(clickCount?.count || '0', 10),
      total_fraud_clicks: parseInt(fraudCount?.count || '0', 10),
      fraud_rate:
        parseInt(clickCount?.count || '0', 10) > 0
          ? parseInt(fraudCount?.count || '0', 10) / parseInt(clickCount?.count || '0', 10)
          : 0,
      total_ads: parseInt(adCount?.count || '0', 10),
      total_campaigns: parseInt(campaignCount?.count || '0', 10),
      total_advertisers: parseInt(advertiserCount?.count || '0', 10),
      clicks_last_24h: parseInt(last24h?.count || '0', 10),
      clicks_last_hour: parseInt(lastHour?.count || '0', 10),
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/admin/recent-clicks
 * Get recent click events for monitoring
 */
router.get('/recent-clicks', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 1000);
    const fraudOnly = req.query.fraud_only === 'true';

    let sql = `
      SELECT click_id, ad_id, campaign_id, advertiser_id, user_id,
             timestamp, device_type, country, is_fraudulent, fraud_reason
      FROM click_events
    `;

    if (fraudOnly) {
      sql += ' WHERE is_fraudulent = true';
    }

    sql += ' ORDER BY timestamp DESC LIMIT $1';

    const clicks = await query(sql, [limit]);
    res.json({ clicks });
  } catch (error) {
    console.error('Error getting recent clicks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
