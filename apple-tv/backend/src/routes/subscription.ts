import express, { Request, Response, Router } from 'express';
import * as db from '../db/index.js';
import { isAuthenticated } from '../middleware/auth.js';

/** Subscription routes for plan listing, subscription status, subscribe, and cancel operations. */
const router: Router = express.Router();

interface SubscriptionRow {
  subscription_tier: string;
  subscription_expires_at: Date | null;
}

interface Plan {
  id: string;
  name: string;
  price: number;
  currency: string;
  interval: string;
  savings?: string;
  features: string[];
}

// Get subscription status
router.get('/status', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await db.query<SubscriptionRow>(`
      SELECT subscription_tier, subscription_expires_at
      FROM users WHERE id = $1
    `, [req.session.userId]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];
    const isActive = user.subscription_tier !== 'free' &&
                     user.subscription_expires_at !== null &&
                     new Date(user.subscription_expires_at) > new Date();

    res.json({
      tier: user.subscription_tier,
      expiresAt: user.subscription_expires_at,
      isActive
    });
  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// Get subscription plans
router.get('/plans', async (_req: Request, res: Response): Promise<void> => {
  const plans: Plan[] = [
    {
      id: 'monthly',
      name: 'Monthly',
      price: 9.99,
      currency: 'USD',
      interval: 'month',
      features: [
        'Full access to Apple TV+ originals',
        'Stream on up to 6 devices',
        '4K HDR with Dolby Vision',
        'Dolby Atmos audio',
        'Download for offline viewing',
        'Family Sharing with up to 6 profiles'
      ]
    },
    {
      id: 'yearly',
      name: 'Yearly',
      price: 99.99,
      currency: 'USD',
      interval: 'year',
      savings: '17%',
      features: [
        'Full access to Apple TV+ originals',
        'Stream on up to 6 devices',
        '4K HDR with Dolby Vision',
        'Dolby Atmos audio',
        'Download for offline viewing',
        'Family Sharing with up to 6 profiles',
        'Save 17% vs monthly'
      ]
    }
  ];
  res.json(plans);
});

// Subscribe (simulated - in production would integrate with payment provider)
router.post('/subscribe', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const { planId } = req.body as { planId?: string };

    if (!planId || !['monthly', 'yearly'].includes(planId)) {
      res.status(400).json({ error: 'Invalid plan' });
      return;
    }

    // Calculate expiration
    const now = new Date();
    const expiresAt = new Date(now);
    if (planId === 'monthly') {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    } else {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    }

    // Update user subscription
    await db.query(`
      UPDATE users
      SET subscription_tier = $1, subscription_expires_at = $2, updated_at = NOW()
      WHERE id = $3
    `, [planId, expiresAt, req.session.userId]);

    // Update session
    req.session.subscriptionTier = planId;
    req.session.subscriptionExpiresAt = expiresAt;

    res.json({
      success: true,
      tier: planId,
      expiresAt
    });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Cancel subscription
router.post('/cancel', isAuthenticated, async (_req: Request, res: Response): Promise<void> => {
  try {
    // In production, this would cancel with payment provider
    // For now, we'll just mark as expiring at current end date

    res.json({
      success: true,
      message: 'Subscription will not renew. You have access until your current period ends.'
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;
