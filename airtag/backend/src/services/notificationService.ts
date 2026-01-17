import pool from '../db/pool.js';
import { Notification } from '../types/index.js';
import redis from '../db/redis.js';

export class NotificationService {
  /**
   * Create a new notification
   */
  async createNotification(data: {
    user_id: string;
    device_id?: string;
    type: Notification['type'];
    title: string;
    message?: string;
    data?: Record<string, unknown>;
  }): Promise<Notification> {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, device_id, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [data.user_id, data.device_id, data.type, data.title, data.message, data.data]
    );

    const notification = result.rows[0];

    // Publish to Redis for real-time updates
    await redis.publish(`notifications:${data.user_id}`, JSON.stringify(notification));

    return notification;
  }

  /**
   * Get notifications for a user
   */
  async getNotifications(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number } = {}
  ): Promise<Notification[]> {
    const limit = options.limit || 50;
    let query = `SELECT * FROM notifications WHERE user_id = $1`;

    if (options.unreadOnly) {
      query += ` AND is_read = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT $2`;

    const result = await pool.query(query, [userId, limit]);
    return result.rows;
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<number> {
    const result = await pool.query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    return result.rowCount ?? 0;
  }

  /**
   * Delete a notification
   */
  async deleteNotification(notificationId: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Get notification statistics (for admin)
   */
  async getNotificationStats(): Promise<{
    total: number;
    unread: number;
    byType: Record<string, number>;
  }> {
    const total = await pool.query(`SELECT COUNT(*) as count FROM notifications`);
    const unread = await pool.query(
      `SELECT COUNT(*) as count FROM notifications WHERE is_read = false`
    );
    const byType = await pool.query(
      `SELECT type, COUNT(*) as count FROM notifications GROUP BY type`
    );

    const typeMap: Record<string, number> = {};
    byType.rows.forEach((row: { type: string; count: string }) => {
      typeMap[row.type] = parseInt(row.count);
    });

    return {
      total: parseInt(total.rows[0].count),
      unread: parseInt(unread.rows[0].count),
      byType: typeMap,
    };
  }
}

export const notificationService = new NotificationService();
