import { query } from '../utils/database.js';
import { redis, cacheGet, cacheSet } from '../utils/redis.js';

export class DeduplicationService {
  // Generate a hash key for deduplication
  generateKey(userId, templateId, channelData) {
    const data = JSON.stringify({ userId, templateId, channelData });
    // Simple hash for deduplication window
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `dedup:${Math.abs(hash).toString(16)}`;
  }

  async isDuplicate(key, windowSeconds = 60) {
    const exists = await redis.get(key);
    if (exists) {
      return true;
    }

    // Set with expiry for deduplication window
    await redis.setex(key, windowSeconds, '1');
    return false;
  }

  async checkDuplicate(userId, templateId, channelData, windowSeconds = 60) {
    const key = this.generateKey(userId, templateId, channelData);
    return this.isDuplicate(key, windowSeconds);
  }
}

export class DeliveryTracker {
  async updateStatus(notificationId, channel, status, details = {}) {
    await query(
      `INSERT INTO delivery_status
         (notification_id, channel, status, details, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (notification_id, channel)
       DO UPDATE SET
         status = $3,
         details = delivery_status.details || $4,
         attempts = delivery_status.attempts + 1,
         updated_at = NOW()`,
      [notificationId, channel, status, JSON.stringify(details)]
    );

    // Update aggregate notification status
    await this.updateNotificationStatus(notificationId);

    return { notificationId, channel, status };
  }

  async updateNotificationStatus(notificationId) {
    const result = await query(
      `SELECT channel, status FROM delivery_status WHERE notification_id = $1`,
      [notificationId]
    );

    const statuses = result.rows;

    if (statuses.length === 0) return;

    // Determine overall status
    const allSent = statuses.every((s) => s.status === 'sent');
    const allFailed = statuses.every((s) => s.status === 'failed');
    const anyPending = statuses.some((s) => s.status === 'pending');

    let overallStatus;
    if (allSent) overallStatus = 'delivered';
    else if (allFailed) overallStatus = 'failed';
    else if (anyPending) overallStatus = 'partial';
    else overallStatus = 'partial_success';

    await query(
      `UPDATE notifications
       SET status = $2,
           delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE NULL END
       WHERE id = $1`,
      [notificationId, overallStatus]
    );
  }

  async trackEvent(notificationId, channel, eventType, metadata = {}) {
    await query(
      `INSERT INTO notification_events
         (notification_id, channel, event_type, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [notificationId, channel, eventType, JSON.stringify(metadata)]
    );
  }

  async getNotificationStatus(notificationId) {
    const notification = await query(
      `SELECT n.*, json_agg(ds.*) as delivery_statuses
       FROM notifications n
       LEFT JOIN delivery_status ds ON n.id = ds.notification_id
       WHERE n.id = $1
       GROUP BY n.id`,
      [notificationId]
    );

    if (notification.rows.length === 0) {
      return null;
    }

    return notification.rows[0];
  }

  async getDeliveryStats(timeRange = '24 hours') {
    const result = await query(
      `SELECT
         channel,
         status,
         COUNT(*) as count
       FROM delivery_status
       WHERE updated_at >= NOW() - $1::interval
       GROUP BY channel, status
       ORDER BY channel, status`,
      [timeRange]
    );

    const stats = {};
    for (const row of result.rows) {
      if (!stats[row.channel]) {
        stats[row.channel] = {};
      }
      stats[row.channel][row.status] = parseInt(row.count);
    }

    return stats;
  }
}

export const deduplicationService = new DeduplicationService();
export const deliveryTracker = new DeliveryTracker();
