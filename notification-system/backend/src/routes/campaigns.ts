import { Router, Request, Response } from 'express';
import { query } from '../utils/database.js';
import { adminMiddleware } from '../middleware/auth.js';
import { notificationService } from '../services/notifications.js';

const router: Router = Router();

interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  target_audience: Record<string, unknown> | null;
  channels: string[];
  priority: string;
  status: string;
  scheduled_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  total_sent?: number;
  total_delivered?: number;
  total_opened?: number;
  total_clicked?: number;
  total_failed?: number;
}

interface CreateCampaignRequest {
  name: string;
  description?: string;
  templateId?: string;
  targetAudience?: Record<string, unknown>;
  channels?: string[];
  priority?: string;
  scheduledAt?: string;
}

interface UpdateCampaignRequest {
  name?: string;
  description?: string;
  templateId?: string;
  targetAudience?: Record<string, unknown>;
  channels?: string[];
  priority?: string;
  scheduledAt?: string;
}

// Get all campaigns
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, limit = '50', offset = '0' } = req.query;

    let queryStr = `
      SELECT c.*, cs.total_sent, cs.total_delivered, cs.total_opened, cs.total_clicked, cs.total_failed
      FROM campaigns c
      LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
    `;
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      queryStr += ` WHERE c.status = $${params.length}`;
    }

    queryStr += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query<CampaignRow>(queryStr, params);
    res.json({ campaigns: result.rows });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ error: 'Failed to get campaigns' });
  }
});

// Get campaign by ID
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<CampaignRow>(
      `SELECT c.*, cs.total_sent, cs.total_delivered, cs.total_opened, cs.total_clicked, cs.total_failed
       FROM campaigns c
       LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

// Create campaign (admin only)
router.post('/', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, templateId, targetAudience, channels, priority, scheduledAt } = req.body as CreateCampaignRequest;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const result = await query<CampaignRow>(
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
        req.user!.id,
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
router.patch('/:id', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, templateId, targetAudience, channels, priority, scheduledAt } = req.body as UpdateCampaignRequest;

    // Check if campaign exists and is editable
    const existing = await query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    if (!['draft', 'scheduled'].includes(existing.rows[0].status)) {
      res.status(400).json({ error: 'Can only edit draft or scheduled campaigns' });
      return;
    }

    const result = await query<CampaignRow>(
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

interface TargetAudience {
  filters?: Array<{ field: string; value: unknown }>;
  data?: Record<string, unknown>;
}

// Start campaign (admin only)
router.post('/:id/start', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    // Claim the campaign atomically. The old SELECT-then-UPDATE let two
    // concurrent starts both pass the status check and both fan out.
    const claimed = await query<CampaignRow>(
      `UPDATE campaigns SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('draft', 'scheduled')
       RETURNING *`,
      [req.params.id]
    );

    if (claimed.rows.length === 0) {
      const exists = await query<{ id: string }>(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
      if (exists.rows.length === 0) {
        res.status(404).json({ error: 'Campaign not found' });
      } else {
        res.status(409).json({ error: 'Campaign cannot be started (already running, completed or cancelled)' });
      }
      return;
    }

    const campaign = claimed.rows[0];

    // Get target users based on audience filters
    let usersQuery = `SELECT id FROM users WHERE role = 'user'`;
    const params: unknown[] = [];

    const targetAudience = campaign.target_audience as TargetAudience | null;
    if (targetAudience?.filters) {
      // Simple filter example - in production this would be more sophisticated
      for (const filter of targetAudience.filters) {
        if (filter.field === 'email_verified' && filter.value) {
          usersQuery += ` AND email_verified = true`;
        }
      }
    }

    const usersResult = await query<{ id: string }>(usersQuery, params);

    // Send notifications to all target users
    let sentCount = 0;
    for (const user of usersResult.rows) {
      try {
        // One durable key per recipient: re-running the fan-out cannot notify anyone twice.
        const result = await notificationService.sendNotification({
          userId: user.id,
          templateId: campaign.template_id || undefined,
          channels: campaign.channels,
          priority: campaign.priority as 'critical' | 'high' | 'normal' | 'low',
          data: targetAudience?.data || {},
          dedupeKey: `campaign:${campaign.id}:${user.id}`,
        });
        if (result.status === 'queued' || result.status === 'scheduled') {
          sentCount++;
        }
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
router.post('/:id/cancel', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<{ id: string }>(
      `UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'scheduled', 'running') RETURNING id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found or cannot be cancelled' });
      return;
    }

    res.json({ message: 'Campaign cancelled' });
  } catch (error) {
    console.error('Cancel campaign error:', error);
    res.status(500).json({ error: 'Failed to cancel campaign' });
  }
});

// Delete campaign (admin only)
router.delete('/:id', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<{ id: string }>(
      `DELETE FROM campaigns WHERE id = $1 AND status = 'draft' RETURNING id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found or cannot be deleted (only drafts can be deleted)' });
      return;
    }

    res.json({ message: 'Campaign deleted' });
  } catch (error) {
    console.error('Delete campaign error:', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

export default router;
