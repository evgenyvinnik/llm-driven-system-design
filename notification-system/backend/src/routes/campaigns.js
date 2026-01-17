import { Router } from 'express';
import { query } from '../utils/database.js';
import { adminMiddleware } from '../middleware/auth.js';
import { notificationService } from '../services/notifications.js';

const router = Router();

// Get all campaigns
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let queryStr = `
      SELECT c.*, cs.total_sent, cs.total_delivered, cs.total_opened, cs.total_clicked, cs.total_failed
      FROM campaigns c
      LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
    `;
    const params = [];

    if (status) {
      params.push(status);
      queryStr += ` WHERE c.status = $${params.length}`;
    }

    queryStr += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryStr, params);
    res.json({ campaigns: result.rows });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ error: 'Failed to get campaigns' });
  }
});

// Get campaign by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, cs.total_sent, cs.total_delivered, cs.total_opened, cs.total_clicked, cs.total_failed
       FROM campaigns c
       LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

// Create campaign (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { name, description, templateId, targetAudience, channels, priority, scheduledAt } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const result = await query(
      `INSERT INTO campaigns (name, description, template_id, target_audience, channels, priority, scheduled_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name,
        description,
        templateId,
        JSON.stringify(targetAudience || {}),
        channels || ['email'],
        priority || 'normal',
        scheduledAt || null,
        scheduledAt ? 'scheduled' : 'draft',
        req.user.id,
      ]
    );

    const campaign = result.rows[0];

    // Create stats record
    await query(
      `INSERT INTO campaign_stats (campaign_id) VALUES ($1)`,
      [campaign.id]
    );

    res.status(201).json(campaign);
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// Update campaign (admin only)
router.patch('/:id', adminMiddleware, async (req, res) => {
  try {
    const { name, description, templateId, targetAudience, channels, priority, scheduledAt } = req.body;

    // Check if campaign exists and is editable
    const existing = await query(
      `SELECT status FROM campaigns WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (!['draft', 'scheduled'].includes(existing.rows[0].status)) {
      return res.status(400).json({ error: 'Can only edit draft or scheduled campaigns' });
    }

    const result = await query(
      `UPDATE campaigns SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         template_id = COALESCE($4, template_id),
         target_audience = COALESCE($5, target_audience),
         channels = COALESCE($6, channels),
         priority = COALESCE($7, priority),
         scheduled_at = COALESCE($8, scheduled_at),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        name,
        description,
        templateId,
        targetAudience ? JSON.stringify(targetAudience) : null,
        channels,
        priority,
        scheduledAt,
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// Start campaign (admin only)
router.post('/:id/start', adminMiddleware, async (req, res) => {
  try {
    const campaignResult = await query(
      `SELECT * FROM campaigns WHERE id = $1`,
      [req.params.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    if (!['draft', 'scheduled'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Campaign cannot be started' });
    }

    // Update status to running
    await query(
      `UPDATE campaigns SET status = 'running', started_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Get target users based on audience filters
    let usersQuery = `SELECT id FROM users WHERE role = 'user'`;
    const params = [];

    if (campaign.target_audience?.filters) {
      // Simple filter example - in production this would be more sophisticated
      for (const filter of campaign.target_audience.filters) {
        if (filter.field === 'email_verified' && filter.value) {
          usersQuery += ` AND email_verified = true`;
        }
      }
    }

    const usersResult = await query(usersQuery, params);

    // Send notifications to all target users
    let sentCount = 0;
    for (const user of usersResult.rows) {
      try {
        await notificationService.sendNotification({
          userId: user.id,
          templateId: campaign.template_id,
          channels: campaign.channels,
          priority: campaign.priority,
          data: campaign.target_audience?.data || {},
        });
        sentCount++;
      } catch (e) {
        console.error(`Failed to send to user ${user.id}:`, e);
      }
    }

    // Update stats
    await query(
      `UPDATE campaign_stats SET total_sent = $2, updated_at = NOW() WHERE campaign_id = $1`,
      [req.params.id, sentCount]
    );

    // Mark as completed
    await query(
      `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({ message: 'Campaign started', sentCount });
  } catch (error) {
    console.error('Start campaign error:', error);
    res.status(500).json({ error: 'Failed to start campaign' });
  }
});

// Cancel campaign (admin only)
router.post('/:id/cancel', adminMiddleware, async (req, res) => {
  try {
    const result = await query(
      `UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'scheduled', 'running') RETURNING id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or cannot be cancelled' });
    }

    res.json({ message: 'Campaign cancelled' });
  } catch (error) {
    console.error('Cancel campaign error:', error);
    res.status(500).json({ error: 'Failed to cancel campaign' });
  }
});

// Delete campaign (admin only)
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM campaigns WHERE id = $1 AND status = 'draft' RETURNING id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or cannot be deleted (only drafts can be deleted)' });
    }

    res.json({ message: 'Campaign deleted' });
  } catch (error) {
    console.error('Delete campaign error:', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

export default router;
