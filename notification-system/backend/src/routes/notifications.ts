import { Router } from 'express';
import { notificationService } from '../services/notifications.js';
import { deliveryTracker } from '../services/delivery.js';
import { rateLimiter } from '../services/rateLimiter.js';

const router = Router();

// Send a notification
router.post('/', async (req, res) => {
  try {
    const result = await notificationService.sendNotification({
      userId: req.body.userId || req.user.id,
      templateId: req.body.templateId,
      data: req.body.data,
      channels: req.body.channels,
      priority: req.body.priority,
      scheduledAt: req.body.scheduledAt,
      deduplicationWindow: req.body.deduplicationWindow,
    });

    res.status(result.notificationId ? 201 : 200).json(result);
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get user's notifications
router.get('/', async (req, res) => {
  try {
    const notifications = await notificationService.getUserNotifications(
      req.user.id,
      {
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.offset) || 0,
        status: req.query.status,
      }
    );

    res.json({ notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Get notification by ID
router.get('/:id', async (req, res) => {
  try {
    const notification = await notificationService.getNotificationById(req.params.id);

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Check ownership unless admin
    if (notification.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(notification);
  } catch (error) {
    console.error('Get notification error:', error);
    res.status(500).json({ error: 'Failed to get notification' });
  }
});

// Cancel a notification
router.delete('/:id', async (req, res) => {
  try {
    const cancelled = await notificationService.cancelNotification(
      req.params.id,
      req.user.id
    );

    if (!cancelled) {
      return res.status(404).json({ error: 'Notification not found or cannot be cancelled' });
    }

    res.json({ message: 'Notification cancelled' });
  } catch (error) {
    console.error('Cancel notification error:', error);
    res.status(500).json({ error: 'Failed to cancel notification' });
  }
});

// Get rate limit usage
router.get('/rate-limit/usage', async (req, res) => {
  try {
    const usage = await rateLimiter.getUsage(req.user.id);
    res.json({ usage, limits: rateLimiter.getLimits().user });
  } catch (error) {
    console.error('Get rate limit usage error:', error);
    res.status(500).json({ error: 'Failed to get rate limit usage' });
  }
});

// Track notification event (opened, clicked)
router.post('/:id/events', async (req, res) => {
  try {
    const { eventType, channel, metadata } = req.body;

    if (!['opened', 'clicked', 'dismissed'].includes(eventType)) {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    await deliveryTracker.trackEvent(
      req.params.id,
      channel || 'push',
      eventType,
      metadata
    );

    res.json({ message: 'Event tracked' });
  } catch (error) {
    console.error('Track event error:', error);
    res.status(500).json({ error: 'Failed to track event' });
  }
});

export default router;
