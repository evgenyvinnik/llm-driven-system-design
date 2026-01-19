import { v4 as uuidv4 } from 'uuid';
import { query } from '../utils/database.js';
import { publishToQueue, getQueueName } from '../utils/rabbitmq.js';
import { preferencesService, UserPreferences } from './preferences.js';
import { rateLimiter } from './rateLimiter.js';
import { templateService } from './templates.js';
import { deduplicationService, deliveryTracker } from './delivery.js';
import { createLogger } from '../utils/logger.js';
import { idempotencyService, IdempotencyConflictError } from '../utils/idempotency.js';
import {
  notificationsSentCounter,
  rateLimitedCounter,
  deduplicatedCounter,
} from '../utils/metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('notification-service');

export interface NotificationRequest {
  idempotencyKey?: string;
  userId: string;
  templateId?: string;
  data?: Record<string, unknown>;
  channels?: string[];
  priority?: 'critical' | 'high' | 'normal' | 'low';
  scheduledAt?: Date | null;
  deduplicationWindow?: number;
}

export interface NotificationResult {
  notificationId: string | null;
  status: string;
  reason?: string;
  retryAfter?: number;
  channels?: string[];
  channel?: string;
  scheduledFor?: Date;
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

interface LogContext {
  userId: string;
  templateId?: string;
  priority: string;
  channels: string[];
  notificationId?: string;
}

export class NotificationService {
  /**
   * Send a notification to a user with idempotency support.
   *
   * If an idempotency key is provided, the request will be deduplicated:
   * - Same key with completed request: returns cached result
   * - Same key with in-progress request: returns 409 Conflict
   */
  async sendNotification(request: NotificationRequest): Promise<NotificationResult> {
    const {
      idempotencyKey,
      userId,
      templateId,
      priority = 'normal',
      channels = ['push', 'email'],
    } = request;

    const logContext: LogContext = { userId, templateId, priority, channels };

    // If idempotency key provided, use idempotency service
    if (idempotencyKey) {
      log.debug({ ...logContext, idempotencyKey }, 'Processing request with idempotency key');

      try {
        const { result, cached } = await idempotencyService.executeWithIdempotency<NotificationResult>(
          idempotencyKey,
          () => this.processNotification(request)
        );

        if (cached) {
          log.info({ ...logContext, idempotencyKey }, 'Returning cached result for idempotent request');
        }

        return result;
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          log.warn({ ...logContext, idempotencyKey }, 'Idempotency conflict - request already processing');
          return {
            notificationId: null,
            status: 'conflict',
            reason: 'Request with this idempotency key is already being processed',
            retryAfter: 5, // Suggest client retry after 5 seconds
          };
        }
        throw error;
      }
    }

    // No idempotency key - process normally
    return this.processNotification(request);
  }

  /**
   * Internal method to process the notification.
   * Separated from sendNotification to support idempotency wrapping.
   */
  async processNotification(request: NotificationRequest): Promise<NotificationResult> {
    const {
      userId,
      templateId,
      data = {},
      channels = ['push', 'email'],
      priority = 'normal',
      scheduledAt,
      deduplicationWindow = 60,
    } = request;

    const logContext: LogContext = { userId, templateId, priority, channels };

    // Validate request
    await this.validate(request);

    // Generate notification ID for tracking
    const notificationId = uuidv4();
    logContext.notificationId = notificationId;

    // Check for duplicates using content-based deduplication
    if (await deduplicationService.checkDuplicate(userId, templateId, data, deduplicationWindow)) {
      log.info(logContext, 'Notification deduplicated');
      deduplicatedCounter.inc();

      return {
        notificationId: null,
        status: 'deduplicated',
        reason: 'Duplicate notification within deduplication window',
      };
    }

    // Check rate limits
    const rateLimitResult = await rateLimiter.checkLimit(userId, channels);
    if (rateLimitResult.limited) {
      log.warn({
        ...logContext,
        reason: rateLimitResult.reason,
        channel: rateLimitResult.channel,
      }, 'Notification rate limited');

      rateLimitedCounter.labels(rateLimitResult.reason || '', rateLimitResult.channel || '').inc();

      return {
        notificationId: null,
        status: 'rate_limited',
        reason: rateLimitResult.reason,
        channel: rateLimitResult.channel,
        retryAfter: rateLimitResult.retryAfter,
      };
    }

    // Get user preferences
    const preferences = await preferencesService.getPreferences(userId);

    // Filter channels based on preferences
    const allowedChannels = preferencesService.filterChannels(channels, preferences);

    if (allowedChannels.length === 0) {
      log.info(logContext, 'Notification suppressed by user preferences');

      return {
        notificationId,
        status: 'suppressed',
        reason: 'user_preferences',
      };
    }

    // Check quiet hours (skip for critical notifications)
    if (preferencesService.isQuietHours(preferences) && priority !== 'critical') {
      // For now, just mark as scheduled for later
      const endOfQuietHours = this.calculateEndOfQuietHours(preferences);

      await query(
        `INSERT INTO notifications
           (id, user_id, template_id, content, channels, priority, status, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7)`,
        [
          notificationId,
          userId,
          templateId,
          JSON.stringify({ templateData: data }),
          allowedChannels,
          priority,
          endOfQuietHours,
        ]
      );

      log.info({
        ...logContext,
        scheduledFor: endOfQuietHours,
      }, 'Notification scheduled for after quiet hours');

      return {
        notificationId,
        status: 'scheduled',
        reason: 'quiet_hours',
        scheduledFor: endOfQuietHours,
      };
    }

    // Render content for each channel
    let content: Record<string, unknown> = {};
    if (templateId) {
      const template = await templateService.getTemplate(templateId);
      if (template) {
        for (const channel of allowedChannels) {
          try {
            content[channel] = templateService.renderTemplate(template, channel, data);
          } catch (_e) {
            log.debug({ channel, templateId }, 'Channel not supported by template');
          }
        }
      }
    }

    // If no template, use provided content directly
    if (Object.keys(content).length === 0) {
      content = (data.content as Record<string, unknown>) || { title: data.title, body: data.body };
    }

    // Create notification record
    await query(
      `INSERT INTO notifications
         (id, user_id, template_id, content, channels, priority, status, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        notificationId,
        userId,
        templateId,
        JSON.stringify(content),
        allowedChannels,
        priority,
        scheduledAt ? 'scheduled' : 'pending',
        scheduledAt || null,
      ]
    );

    // Route to channel queues
    if (!scheduledAt) {
      for (const channel of allowedChannels) {
        await this.routeToChannel(
          notificationId,
          userId,
          channel,
          priority,
          (content[channel] as Record<string, unknown>) || content
        );
      }
    }

    log.info({
      ...logContext,
      channels: allowedChannels,
      scheduled: !!scheduledAt,
    }, 'Notification queued successfully');

    notificationsSentCounter.labels('all', priority, 'queued').inc();

    return {
      notificationId,
      status: scheduledAt ? 'scheduled' : 'queued',
      channels: allowedChannels,
    };
  }

  async routeToChannel(
    notificationId: string,
    userId: string,
    channel: string,
    priority: string,
    content: Record<string, unknown>
  ): Promise<void> {
    const queueName = getQueueName(channel, priority);

    await publishToQueue(queueName, {
      notificationId,
      userId,
      channel,
      content,
      priority,
      queuedAt: Date.now(),
    });

    // Create delivery status record
    await deliveryTracker.updateStatus(notificationId, channel, 'pending');

    log.debug({
      notificationId,
      channel,
      priority,
      queueName,
    }, 'Notification routed to channel queue');
  }

  async validate(request: NotificationRequest): Promise<void> {
    if (!request.userId) {
      throw new Error('userId is required');
    }

    // Check if user exists
    const userResult = await query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [request.userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    // Validate channels
    const validChannels = ['push', 'email', 'sms'];
    for (const channel of request.channels || []) {
      if (!validChannels.includes(channel)) {
        throw new Error(`Invalid channel: ${channel}`);
      }
    }

    // Validate priority
    const validPriorities = ['critical', 'high', 'normal', 'low'];
    if (request.priority && !validPriorities.includes(request.priority)) {
      throw new Error(`Invalid priority: ${request.priority}`);
    }
  }

  calculateEndOfQuietHours(preferences: UserPreferences): Date {
    const now = new Date();
    const endMinutes = preferences.quietHoursEnd || 0;

    const endTime = new Date(now);
    endTime.setHours(Math.floor(endMinutes / 60));
    endTime.setMinutes(endMinutes % 60);
    endTime.setSeconds(0);
    endTime.setMilliseconds(0);

    // If end time is before current time, it's tomorrow
    if (endTime <= now) {
      endTime.setDate(endTime.getDate() + 1);
    }

    return endTime;
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
    const result = await query<{ id: string }>(
      `UPDATE notifications
       SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'scheduled')
       RETURNING id`,
      [notificationId, userId]
    );

    if (result.rows.length > 0) {
      log.info({ notificationId, userId }, 'Notification cancelled');
    }

    return result.rows.length > 0;
  }
}

export const notificationService = new NotificationService();
