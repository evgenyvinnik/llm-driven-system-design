import { Router, Request, Response } from 'express';
import { notificationService, NotificationRequestError, NotificationResult } from '../services/notifications.js';
import { deliveryTracker } from '../services/delivery.js';
import { rateLimiter } from '../services/rateLimiter.js';
import { idempotencyService } from '../utils/idempotency.js';
import { query } from '../utils/database.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

/** 202 when accepted for (later) delivery, 429 when rate limited, 200 when there was nothing to send. */
function httpStatusFor(result: NotificationResult): number {
  switch (result.status) {
    case 'queued':
    case 'scheduled':
      return 202;
    case 'rate_limited':
      return 429;
    default:
      return 200;
  }
}

const router: Router = Router();

interface SendNotificationRequest {
  userId?: string;
  templateId?: string;
  data?: Record<string, unknown>;
  channels?: string[];
  priority?: 'critical' | 'high' | 'normal' | 'low';
  scheduledAt?: string;
  deduplicationWindow?: number;
}

interface TrackEventRequest {
  eventType: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

// Send a notification. Regular users may only notify themselves; sending to
// another user (previously open to every logged-in user) requires admin.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as SendNotificationRequest;
  const caller = req.user!;
  const targetUserId = body.userId || caller.id;

  if (targetUserId !== caller.id && caller.role !== 'admin') {
    res.status(403).json({ error: 'Only administrators can send notifications to other users' });
    return;
  }

  const idempotencyKey = req.get('Idempotency-Key');
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    res.status(400).json({ error: 'Idempotency-Key must be 1-200 printable ASCII characters' });
    return;
  }

  const fingerprint = idempotencyService.fingerprint({ ...body, userId: targetUserId });
  let claimToken: string | null = null;

  if (idempotencyKey) {
    const begin = await idempotencyService.begin(caller.id, idempotencyKey, fingerprint);
    if (begin.kind === 'replay') {
      res.set('Idempotent-Replayed', 'true').status(begin.status).json(begin.body);
      return;
    }
    if (begin.kind === 'in_progress') {
      res.set('Retry-After', '1').status(409).json({ error: 'A request with this Idempotency-Key is still in progress' });
      return;
    }
    if (begin.kind === 'mismatch') {
      res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
      return;
    }
    if (begin.kind === 'new') claimToken = begin.token;
  }

  try {
    const result = await notificationService.sendNotification({
      userId: targetUserId,
      templateId: body.templateId,
      data: body.data,
      channels: body.channels,
      priority: body.priority,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
      deduplicationWindow: body.deduplicationWindow,
    });

    const status = httpStatusFor(result);
    if (result.status === 'rate_limited' && result.retryAfter) {
      res.set('Retry-After', String(result.retryAfter));
    }
    if (idempotencyKey && claimToken) {
      if (status < 300) {
        await idempotencyService.complete(caller.id, idempotencyKey, claimToken, fingerprint, status, result);
      } else {
        await idempotencyService.release(caller.id, idempotencyKey, claimToken);
      }
    }
    res.status(status).json(result);
  } catch (error) {
    if (idempotencyKey && claimToken) {
      await idempotencyService.release(caller.id, idempotencyKey, claimToken);
    }
    if (error instanceof NotificationRequestError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Get user's notifications
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const notifications = await notificationService.getUserNotifications(
      req.user!.id,
      {
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
        status: req.query.status as string | undefined,
      }
    );

    res.json({ notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Get notification by ID
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!UUID_PATTERN.test(req.params.id as string)) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    const notification = await notificationService.getNotificationById(req.params.id as string);

    if (!notification) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    // Check ownership unless admin
    if (notification.user_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json(notification);
  } catch (error) {
    console.error('Get notification error:', error);
    res.status(500).json({ error: 'Failed to get notification' });
  }
});

// Cancel a notification
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!UUID_PATTERN.test(req.params.id as string)) {
      res.status(404).json({ error: 'Notification not found or cannot be cancelled' });
      return;
    }
    const cancelled = await notificationService.cancelNotification(
      req.params.id as string,
      req.user!.id
    );

    if (!cancelled) {
      res.status(404).json({ error: 'Notification not found or cannot be cancelled' });
      return;
    }

    res.json({ message: 'Notification cancelled' });
  } catch (error) {
    console.error('Cancel notification error:', error);
    res.status(500).json({ error: 'Failed to cancel notification' });
  }
});

// Get rate limit usage
router.get('/rate-limit/usage', async (req: Request, res: Response): Promise<void> => {
  try {
    const usage = await rateLimiter.getUsage(req.user!.id);
    res.json({ usage, limits: rateLimiter.getLimits().user });
  } catch (error) {
    console.error('Get rate limit usage error:', error);
    res.status(500).json({ error: 'Failed to get rate limit usage' });
  }
});

// Track notification event (opened, clicked)
router.post('/:id/events', async (req: Request, res: Response): Promise<void> => {
  try {
    const { eventType, channel, metadata } = req.body as TrackEventRequest;

    if (!['opened', 'clicked', 'dismissed'].includes(eventType)) {
      res.status(400).json({ error: 'Invalid event type' });
      return;
    }

    // Only the recipient (or an admin) may record events, and only for a
    // channel the notification was actually sent on. Previously any logged-in
    // user could write open/click events against any notification id.
    const notificationId = req.params.id as string;
    const owner = UUID_PATTERN.test(notificationId)
      ? await query<{ user_id: string; channels: string[] }>(
        `SELECT user_id, channels FROM notifications WHERE id = $1`,
        [notificationId]
      )
      : { rows: [] as Array<{ user_id: string; channels: string[] }> };
    const notification = owner.rows[0];
    if (!notification || (notification.user_id !== req.user!.id && req.user!.role !== 'admin')) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    const eventChannel = channel || notification.channels[0];
    if (!notification.channels.includes(eventChannel)) {
      res.status(400).json({ error: 'Notification was not sent on that channel' });
      return;
    }

    await deliveryTracker.trackEvent(
      notificationId,
      eventChannel,
      eventType,
      metadata || {}
    );

    res.json({ message: 'Event tracked' });
  } catch (error) {
    console.error('Track event error:', error);
    res.status(500).json({ error: 'Failed to track event' });
  }
});

export default router;
