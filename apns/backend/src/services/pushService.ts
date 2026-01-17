import db from "../db/index.js";
import redis, {
  enqueueNotification,
  getDeviceServer,
  publishNotification,
} from "../db/redis.js";
import {
  Notification,
  NotificationPayload,
  NotificationPriority,
  NotificationStatus,
  PendingNotification,
  SendNotificationResponse,
} from "../types/index.js";
import { generateUUID, isExpired, parseExpiration } from "../utils/index.js";
import { tokenRegistry } from "./tokenRegistry.js";

export class PushService {
  private serverId: string;

  constructor() {
    this.serverId = `server-${process.env.PORT || 3000}`;
  }

  async sendToDevice(
    deviceToken: string,
    payload: NotificationPayload,
    options: {
      priority?: NotificationPriority;
      expiration?: number;
      collapseId?: string;
    } = {}
  ): Promise<SendNotificationResponse> {
    const device = await tokenRegistry.lookup(deviceToken);

    if (!device) {
      throw new Error("Unregistered device token");
    }

    const notificationId = generateUUID();
    const priority = options.priority || 10;
    const expiration = parseExpiration(options.expiration);

    // Create notification record
    await db.query(
      `INSERT INTO notifications (id, device_id, payload, priority, expiration, collapse_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [
        notificationId,
        device.device_id,
        JSON.stringify(payload),
        priority,
        expiration,
        options.collapseId || null,
      ]
    );

    // Try to deliver immediately or queue
    const result = await this.deliverNotification({
      id: notificationId,
      device_id: device.device_id,
      payload,
      priority,
      expiration,
      collapse_id: options.collapseId || null,
      created_at: new Date(),
    });

    return {
      notification_id: notificationId,
      status: result.delivered ? "delivered" : "queued",
    };
  }

  async sendToDeviceById(
    deviceId: string,
    payload: NotificationPayload,
    options: {
      priority?: NotificationPriority;
      expiration?: number;
      collapseId?: string;
    } = {}
  ): Promise<SendNotificationResponse> {
    const device = await tokenRegistry.lookupById(deviceId);

    if (!device || !device.is_valid) {
      throw new Error("Invalid device ID");
    }

    const notificationId = generateUUID();
    const priority = options.priority || 10;
    const expiration = parseExpiration(options.expiration);

    // Create notification record
    await db.query(
      `INSERT INTO notifications (id, device_id, payload, priority, expiration, collapse_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [
        notificationId,
        deviceId,
        JSON.stringify(payload),
        priority,
        expiration,
        options.collapseId || null,
      ]
    );

    // Try to deliver immediately or queue
    const result = await this.deliverNotification({
      id: notificationId,
      device_id: deviceId,
      payload,
      priority,
      expiration,
      collapse_id: options.collapseId || null,
      created_at: new Date(),
    });

    return {
      notification_id: notificationId,
      status: result.delivered ? "delivered" : "queued",
    };
  }

  async sendToTopic(
    topic: string,
    payload: NotificationPayload,
    options: {
      priority?: NotificationPriority;
      expiration?: number;
      collapseId?: string;
    } = {}
  ): Promise<SendNotificationResponse> {
    const devices = await tokenRegistry.getDevicesForTopic(topic);

    if (devices.length === 0) {
      return {
        notification_id: generateUUID(),
        status: "no_subscribers",
        queued_count: 0,
      };
    }

    const notificationId = generateUUID();
    let queuedCount = 0;

    // Send to each subscribed device
    for (const device of devices) {
      try {
        await this.sendToDeviceById(device.device_id, payload, {
          ...options,
          collapseId: options.collapseId
            ? `${options.collapseId}-${device.device_id}`
            : undefined,
        });
        queuedCount++;
      } catch (error) {
        console.error(
          `Failed to send to device ${device.device_id}:`,
          error
        );
      }
    }

    return {
      notification_id: notificationId,
      status: "queued",
      queued_count: queuedCount,
    };
  }

  private async deliverNotification(
    notification: PendingNotification
  ): Promise<{ delivered: boolean; queued: boolean }> {
    const { id, device_id, payload, priority, expiration, collapse_id } =
      notification;

    // Check expiration
    if (isExpired(expiration)) {
      await this.updateNotificationStatus(id, "expired");
      return { delivered: false, queued: false };
    }

    // Check if device is connected
    const deviceServer = await getDeviceServer(device_id);

    if (deviceServer) {
      // Device is connected - publish for delivery
      await publishNotification(`notifications:${deviceServer}`, {
        type: "push",
        notification_id: id,
        device_id,
        payload,
        priority,
      });

      return { delivered: true, queued: false };
    }

    // Device offline - store for later delivery
    await this.storeForDelivery(notification);
    return { delivered: false, queued: true };
  }

  private async storeForDelivery(notification: PendingNotification): Promise<void> {
    const { id, device_id, payload, priority, expiration, collapse_id } =
      notification;

    // Handle collapse ID - replace existing notification with same ID
    if (collapse_id) {
      await db.query(
        `DELETE FROM pending_notifications
         WHERE device_id = $1 AND collapse_id = $2`,
        [device_id, collapse_id]
      );
    }

    // Store in pending notifications
    await db.query(
      `INSERT INTO pending_notifications
         (id, device_id, payload, priority, expiration, collapse_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (device_id, collapse_id)
       DO UPDATE SET payload = $3, priority = $4, created_at = NOW()`,
      [id, device_id, JSON.stringify(payload), priority, expiration, collapse_id]
    );

    // Also queue by priority for processing
    await enqueueNotification(priority, { id, device_id });

    await this.updateNotificationStatus(id, "queued");
  }

  async updateNotificationStatus(
    notificationId: string,
    status: NotificationStatus
  ): Promise<void> {
    await db.query(
      `UPDATE notifications SET status = $2, updated_at = NOW() WHERE id = $1`,
      [notificationId, status]
    );
  }

  async markDelivered(notificationId: string): Promise<void> {
    await db.query(
      `UPDATE notifications SET status = 'delivered', updated_at = NOW() WHERE id = $1`,
      [notificationId]
    );

    await db.query(
      `INSERT INTO delivery_log (notification_id, device_id, status, delivered_at, created_at)
       SELECT id, device_id, 'delivered', NOW(), NOW()
       FROM notifications WHERE id = $1`,
      [notificationId]
    );

    // Remove from pending if exists
    await db.query(`DELETE FROM pending_notifications WHERE id = $1`, [
      notificationId,
    ]);
  }

  async getPendingNotifications(deviceId: string): Promise<PendingNotification[]> {
    const result = await db.query<PendingNotification>(
      `SELECT * FROM pending_notifications
       WHERE device_id = $1
       AND (expiration IS NULL OR expiration > NOW())
       ORDER BY priority DESC, created_at ASC`,
      [deviceId]
    );

    return result.rows;
  }

  async deliverPendingToDevice(deviceId: string): Promise<number> {
    const pending = await this.getPendingNotifications(deviceId);
    let deliveredCount = 0;

    for (const notification of pending) {
      await publishNotification(`notifications:${this.serverId}`, {
        type: "push",
        notification_id: notification.id,
        device_id: notification.device_id,
        payload: notification.payload,
        priority: notification.priority,
      });
      deliveredCount++;
    }

    // Clean up delivered
    await db.query(`DELETE FROM pending_notifications WHERE device_id = $1`, [
      deviceId,
    ]);

    return deliveredCount;
  }

  async getNotification(notificationId: string): Promise<Notification | null> {
    const result = await db.query<Notification>(
      `SELECT * FROM notifications WHERE id = $1`,
      [notificationId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async getNotifications(
    options: {
      deviceId?: string;
      status?: NotificationStatus;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ notifications: Notification[]; total: number }> {
    const { deviceId, status, limit = 100, offset = 0 } = options;

    let whereClause = "WHERE 1=1";
    const params: unknown[] = [];

    if (deviceId) {
      params.push(deviceId);
      whereClause += ` AND device_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      whereClause += ` AND status = $${params.length}`;
    }

    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) FROM notifications ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(limit);
    params.push(offset);

    const result = await db.query<Notification>(
      `SELECT * FROM notifications ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { notifications: result.rows, total };
  }

  async getNotificationStats(): Promise<{
    total: number;
    pending: number;
    queued: number;
    delivered: number;
    failed: number;
    expired: number;
  }> {
    const result = await db.query<{
      total: string;
      pending: string;
      queued: string;
      delivered: string;
      failed: string;
      expired: string;
    }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'pending') as pending,
         COUNT(*) FILTER (WHERE status = 'queued') as queued,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         COUNT(*) FILTER (WHERE status = 'expired') as expired
       FROM notifications`
    );

    return {
      total: parseInt(result.rows[0].total, 10),
      pending: parseInt(result.rows[0].pending, 10),
      queued: parseInt(result.rows[0].queued, 10),
      delivered: parseInt(result.rows[0].delivered, 10),
      failed: parseInt(result.rows[0].failed, 10),
      expired: parseInt(result.rows[0].expired, 10),
    };
  }

  async cleanupExpiredNotifications(): Promise<number> {
    // Update expired notifications
    const result = await db.query(
      `UPDATE notifications SET status = 'expired', updated_at = NOW()
       WHERE status IN ('pending', 'queued')
       AND expiration IS NOT NULL
       AND expiration < NOW()`
    );

    // Remove from pending queue
    await db.query(
      `DELETE FROM pending_notifications WHERE expiration < NOW()`
    );

    return result.rowCount || 0;
  }
}

export const pushService = new PushService();
