import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../utils/database.js';
import { preferencesService } from './preferences.js';
import { rateLimiter } from './rateLimiter.js';
import { templateService } from './templates.js';
import { deduplicationService, deliveryTracker } from './delivery.js';
import { enqueueDeliveries } from './outbox.js';
import { deliveryTimeAfterQuietHours } from './quietHours.js';
import { createLogger } from '../utils/logger.js';
import {
  notificationsSentCounter,
  rateLimitedCounter,
  deduplicatedCounter,
} from '../utils/metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('notification-service');

export interface NotificationRequest {
  userId: string;
  templateId?: string;
  data?: Record<string, unknown>;
  channels?: string[];
  priority?: 'critical' | 'high' | 'normal' | 'low';
  scheduledAt?: Date | null;
  deduplicationWindow?: number;
  /** Durable per-recipient key, e.g. campaign:{id}:{user}; a repeat creates nothing. */
  dedupeKey?: string;
}

export interface NotificationResult {
  notificationId: string | null;
  status: 'queued' | 'scheduled' | 'deduplicated' | 'suppressed' | 'rate_limited' | 'duplicate';
  reason?: string;
  retryAfter?: number;
  channels?: string[];
  channel?: string;
  scheduledFor?: Date;
}

/** Thrown for requests that can never succeed as sent (HTTP 4xx). */
export class NotificationRequestError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'NotificationRequestError';
    this.statusCode = statusCode;
  }
}

interface GetNotificationsOptions {
  limit?: number;
  offset?: number;
  status?: string;
}

interface NotificationRow {
  id: string;
  user_id: string;
  template_id: string | null;
  content: Record<string, unknown>;
  channels: string[];
  priority: string;
  status: string;
  scheduled_at: Date | null;
  created_at: Date;
  delivered_at: Date | null;
  delivery_statuses: unknown[];
}

const VALID_CHANNELS = ['push', 'email', 'sms'];
const VALID_PRIORITIES = ['critical', 'high', 'normal', 'low'];

/** Orchestrates validation, preferences, dedup, rate limiting and the outbox write. */
export class NotificationService {
  /**
   * Accepts a notification for delivery. Nothing is published to RabbitMQ
   * here: the notification, one delivery row per channel and one outbox row
   * per channel are committed in a single transaction, and the relay in the
   * worker publishes them when they are due. Either all of it exists or none.
   *
   * HTTP-level idempotency (Idempotency-Key) is handled by the route.
   */
  async sendNotification(request: NotificationRequest): Promise<NotificationResult> {
    const {
      userId,
      templateId,
      data = {},
      priority = 'normal',
      scheduledAt,
      deduplicationWindow = 60,
      dedupeKey,
    } = request;
    const channels = [...new Set(request.channels ?? ['push', 'email'])];

    await this.validate({ ...request, channels });
    const logContext = { userId, templateId, priority, channels };

    // 1. Preferences first (cached), so a suppressed send spends no dedup or rate budget.
    const preferences = await preferencesService.getPreferences(userId);
    const allowedChannels = preferencesService.filterChannels(channels, preferences);
    if (allowedChannels.length === 0) {
      log.info(logContext, 'Notification suppressed by user preferences');
      return { notificationId: null, status: 'suppressed', reason: 'user_preferences' };
    }

    // 2. Content dedup: atomic claim, released below if nothing gets created.
    const dedupKey = deduplicationService.generateKey(userId, templateId, data);
    if (!(await deduplicationService.claim(dedupKey, deduplicationWindow))) {
      log.info(logContext, 'Notification deduplicated');
      deduplicatedCounter.inc();
      return {
        notificationId: null,
        status: 'deduplicated',
        reason: 'Duplicate notification within deduplication window',
      };
    }

    try {
      // 3. Rate limits: all channels admitted together, or none.
      const rateLimitResult = await rateLimiter.checkLimit(userId, allowedChannels);
      if (rateLimitResult.limited) {
        await deduplicationService.release(dedupKey);
        log.warn({ ...logContext, reason: rateLimitResult.reason, channel: rateLimitResult.channel }, 'Notification rate limited');
        rateLimitedCounter.labels(rateLimitResult.reason || '', rateLimitResult.channel || '').inc();
        return {
          notificationId: null,
          status: 'rate_limited',
          reason: rateLimitResult.reason,
          channel: rateLimitResult.channel,
          retryAfter: rateLimitResult.retryAfter,
        };
      }

      // 4. When may it go out? Requested time, pushed past quiet hours
      //    (evaluated in the user's time zone) unless it is critical.
      const now = new Date();
      const requestedAt = scheduledAt && scheduledAt.getTime() > now.getTime() ? scheduledAt : now;
      const { deliverAt, deferred } = deliveryTimeAfterQuietHours(preferences, requestedAt, priority);
      const isScheduled = deliverAt.getTime() > now.getTime() + 1000;

      // 5. Render per channel now, so the stored content is exactly what is sent.
      const content = await this.renderContent(templateId, allowedChannels, data);

      // 6. One transaction: notification + delivery rows + outbox rows.
      const notificationId = uuidv4();
      const created = await withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO notifications
             (id, user_id, template_id, content, channels, priority, status, scheduled_at, dedupe_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            notificationId,
            userId,
            templateId || null,
            JSON.stringify(content),
            allowedChannels,
            priority,
            isScheduled ? 'scheduled' : 'pending',
            isScheduled ? deliverAt : null,
            dedupeKey || null,
          ]
        );
        if (inserted.rowCount === 0) return false;

        await deliveryTracker.createDeliveries(client, notificationId, allowedChannels, isScheduled ? deliverAt : null);
        await enqueueDeliveries(client, allowedChannels.map((channel) => ({
          notificationId,
          userId,
          channel,
          priority,
          availableAt: deliverAt,
        })));
        return true;
      });

      if (!created) {
        await deduplicationService.release(dedupKey);
        log.info({ ...logContext, dedupeKey }, 'Recipient already has this notification');
        return { notificationId: null, status: 'duplicate', reason: 'dedupe_key_exists' };
      }

      notificationsSentCounter.labels('all', priority, isScheduled ? 'scheduled' : 'queued').inc();
      log.info({ ...logContext, notificationId, channels: allowedChannels, deliverAt, deferred }, 'Notification accepted');

      if (isScheduled) {
        return {
          notificationId,
          status: 'scheduled',
          reason: deferred ? 'quiet_hours' : 'scheduled',
          channels: allowedChannels,
          scheduledFor: deliverAt,
        };
      }
      return { notificationId, status: 'queued', channels: allowedChannels };
    } catch (error) {
      await deduplicationService.release(dedupKey);
      throw error;
    }
  }

  /** Per-channel content from the template, or the caller's title/body. */
  private async renderContent(
    templateId: string | undefined,
    channels: string[],
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (templateId) {
      const template = await templateService.getTemplate(templateId);
      if (!template) {
        throw new NotificationRequestError(`Template not found: ${templateId}`);
      }
      const content: Record<string, unknown> = {};
      for (const channel of channels) {
        if (template.channels[channel]) {
          content[channel] = templateService.renderTemplate(template, channel, data);
        }
      }
      if (Object.keys(content).length > 0) return content;
    }
    return (data.content as Record<string, unknown>) || { title: data.title, body: data.body };
  }

  async validate(request: NotificationRequest): Promise<void> {
    if (!request.userId) {
      throw new NotificationRequestError('userId is required');
    }

    // Check if user exists
    const userResult = await query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [request.userId]
    );

    if (userResult.rows.length === 0) {
      throw new NotificationRequestError('User not found', 404);
    }

    // Validate channels
    if (request.channels && request.channels.length === 0) {
      throw new NotificationRequestError('At least one channel is required');
    }
    for (const channel of request.channels || []) {
      if (!VALID_CHANNELS.includes(channel)) {
        throw new NotificationRequestError(`Invalid channel: ${channel}`);
      }
    }

    // Validate priority
    if (request.priority && !VALID_PRIORITIES.includes(request.priority)) {
      throw new NotificationRequestError(`Invalid priority: ${request.priority}`);
    }

    if (request.scheduledAt && Number.isNaN(request.scheduledAt.getTime())) {
      throw new NotificationRequestError('scheduledAt must be an ISO-8601 timestamp');
    }
  }

  async getUserNotifications(
    userId: string,
    options: GetNotificationsOptions = {}
  ): Promise<NotificationRow[]> {
    const { limit = 50, offset = 0, status } = options;

    let queryStr = `
      SELECT n.*, json_agg(ds.*) as delivery_statuses
      FROM notifications n
      LEFT JOIN delivery_status ds ON n.id = ds.notification_id
      WHERE n.user_id = $1
    `;
    const params: unknown[] = [userId];

    if (status) {
      params.push(status);
      queryStr += ` AND n.status = $${params.length}`;
    }

    queryStr += ` GROUP BY n.id ORDER BY n.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query<NotificationRow>(queryStr, params);
    return result.rows;
  }

  async getNotificationById(notificationId: string) {
    return deliveryTracker.getNotificationStatus(notificationId);
  }

  async cancelNotification(notificationId: string, userId: string): Promise<boolean> {
    const cancelled = await deliveryTracker.cancel(notificationId, userId);
    if (cancelled) {
      log.info({ notificationId, userId }, 'Notification cancelled');
    }
    return cancelled;
  }
}

export const notificationService = new NotificationService();
