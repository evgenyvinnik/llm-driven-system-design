import { v4 as uuidv4 } from 'uuid';
import { query } from '../utils/database.js';
import { publishToQueue, getQueueName } from '../utils/rabbitmq.js';
import { preferencesService } from './preferences.js';
import { rateLimiter } from './rateLimiter.js';
import { templateService } from './templates.js';
import { deduplicationService, deliveryTracker } from './delivery.js';

export class NotificationService {
  async sendNotification(request) {
    const {
      userId,
      templateId,
      data = {},
      channels = ['push', 'email'],
      priority = 'normal',
      scheduledAt,
      deduplicationWindow = 60,
    } = request;

    // Validate request
    await this.validate(request);

    // Generate notification ID for tracking
    const notificationId = uuidv4();

    // Check for duplicates
    if (await deduplicationService.checkDuplicate(userId, templateId, data, deduplicationWindow)) {
      return {
        notificationId: null,
        status: 'deduplicated',
        reason: 'Duplicate notification within deduplication window',
      };
    }

    // Check rate limits
    const rateLimitResult = await rateLimiter.checkLimit(userId, channels);
    if (rateLimitResult.limited) {
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

      return {
        notificationId,
        status: 'scheduled',
        reason: 'quiet_hours',
        scheduledFor: endOfQuietHours,
      };
    }

    // Render content for each channel
    let content = {};
    if (templateId) {
      const template = await templateService.getTemplate(templateId);
      if (template) {
        for (const channel of allowedChannels) {
          try {
            content[channel] = templateService.renderTemplate(template, channel, data);
          } catch (e) {
            // Channel not supported by template, skip
          }
        }
      }
    }

    // If no template, use provided content directly
    if (Object.keys(content).length === 0) {
      content = data.content || { title: data.title, body: data.body };
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
        await this.routeToChannel(notificationId, userId, channel, priority, content[channel] || content);
      }
    }

    return {
      notificationId,
      status: scheduledAt ? 'scheduled' : 'queued',
      channels: allowedChannels,
    };
  }

  async routeToChannel(notificationId, userId, channel, priority, content) {
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
  }

  async validate(request) {
    if (!request.userId) {
      throw new Error('userId is required');
    }

    // Check if user exists
    const userResult = await query(
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

  calculateEndOfQuietHours(preferences) {
    const now = new Date();
    const endMinutes = preferences.quietHoursEnd;

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

  async getUserNotifications(userId, options = {}) {
    const { limit = 50, offset = 0, status } = options;

    let queryStr = `
      SELECT n.*, json_agg(ds.*) as delivery_statuses
      FROM notifications n
      LEFT JOIN delivery_status ds ON n.id = ds.notification_id
      WHERE n.user_id = $1
    `;
    const params = [userId];

    if (status) {
      params.push(status);
      queryStr += ` AND n.status = $${params.length}`;
    }

    queryStr += ` GROUP BY n.id ORDER BY n.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);
    return result.rows;
  }

  async getNotificationById(notificationId) {
    return deliveryTracker.getNotificationStatus(notificationId);
  }

  async cancelNotification(notificationId, userId) {
    const result = await query(
      `UPDATE notifications
       SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'scheduled')
       RETURNING id`,
      [notificationId, userId]
    );

    return result.rows.length > 0;
  }
}

export const notificationService = new NotificationService();
