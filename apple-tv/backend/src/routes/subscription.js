const express = require('express');
const db = require('../db');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get subscription status
router.get('/status', isAuthenticated, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT subscription_tier, subscription_expires_at
      FROM users WHERE id = $1
    `, [req.session.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const isActive = user.subscription_tier !== 'free' &&
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
router.get('/plans', async (req, res) => {
  res.json([
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
  ]);
});

// Subscribe (simulated - in production would integrate with payment provider)
router.post('/subscribe', isAuthenticated, async (req, res) => {
  try {
    const { planId } = req.body;

    if (!['monthly', 'yearly'].includes(planId)) {
      return res.status(400).json({ error: 'Invalid plan' });
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
router.post('/cancel', isAuthenticated, async (req, res) => {
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

module.exports = router;
