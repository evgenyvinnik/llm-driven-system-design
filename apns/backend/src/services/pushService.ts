import db from "../db/index.js";
import _redis, {
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
import {
  checkIdempotency,
  markNotificationProcessed,
} from "../shared/cache.js";
import {
  notificationsSent,
  notificationDeliveryLatency,
  pendingNotifications,
  notificationsInFlight,
  idempotencyChecks,
} from "../shared/metrics.js";
import { logger, logDelivery } from "../shared/logger.js";

/**
 * Push Notification Service.
 *
 * Handles the core notification delivery logic including:
 * - Sending to individual devices or topics
 * - Store-and-forward for offline devices
 * - Collapse ID deduplication
 * - Priority-based queuing
 * - Expiration handling
 */
export class PushService {
  /** Unique identifier for this server instance, used for pub/sub routing */
  private serverId: string;

  constructor() {
    this.serverId = `server-${process.env.PORT || 3000}`;
  }

  /**
   * Sends a notification to a device by its raw token.
   * Creates a notification record and attempts immediate delivery.
   * If device is offline, queues for later delivery.
   * Uses idempotency keys to prevent duplicate notifications.
   *
   * @param deviceToken - Raw 64-character hex device token
   * @param payload - APNs notification payload
   * @param options - Delivery options (priority, expiration, collapse ID, idempotency key)
   * @returns Notification ID and delivery status
   * @throws Error if device token is not registered
   */
  async sendToDevice(
    deviceToken: string,
    payload: NotificationPayload,
    options: {
      priority?: NotificationPriority;
      expiration?: number;
      collapseId?: string;
      idempotencyKey?: string;
    } = {}
  ): Promise<SendNotificationResponse> {
    const startTime = Date.now();
    const notificationId = options.idempotencyKey || generateUUID();
    const priority = options.priority || 10;

    // Check idempotency - prevent duplicate notifications
    if (options.idempotencyKey) {
      const isDuplicate = await checkIdempotency(options.idempotencyKey);
      if (isDuplicate) {
        idempotencyChecks.inc({ result: "duplicate" });
        logger.info({
          event: "notification_duplicate",
          notification_id: notificationId,
          device_token_prefix: deviceToken.substring(0, 8),
        });
        // Return existing notification status without reprocessing
        const existing = await this.getNotification(notificationId);
        return {
          notification_id: notificationId,
          status: existing?.status || "duplicate",
        };
      }
      idempotencyChecks.inc({ result: "new" });
    }

    notificationsInFlight.inc();

    try {
      const device = await tokenRegistry.lookup(deviceToken);

      if (!device) {
        notificationsInFlight.dec();
        throw new Error("Unregistered device token");
      }

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

      // Mark as processed for idempotency
      await markNotificationProcessed(notificationId);

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

      const status = result.delivered ? "delivered" : "queued";
      const latency = (Date.now() - startTime) / 1000;

      // Record metrics
      notificationsSent.inc({ priority: priority.toString(), status });
      notificationDeliveryLatency.observe({ priority: priority.toString() }, latency);

      logDelivery(notificationId, device.device_id, status, {
        priority,
        latency_ms: Date.now() - startTime,
      });

      notificationsInFlight.dec();

      return {
        notification_id: notificationId,
        status,
      };
    } catch (error) {
      notificationsInFlight.dec();
      notificationsSent.inc({ priority: priority.toString(), status: "failed" });
      throw error;
    }
  }

  /**
   * Sends a notification to a device by its server-assigned ID.
   * Similar to sendToDevice but uses the internal device ID.
   * Includes metrics tracking and structured logging.
   *
   * @param deviceId - Server-assigned device UUID
   * @param payload - APNs notification payload
   * @param options - Delivery options (priority, expiration, collapse ID)
   * @returns Notification ID and delivery status
   * @throws Error if device ID is invalid
   */
  async sendToDeviceById(
    deviceId: string,
    payload: NotificationPayload,
    options: {
      priority?: NotificationPriority;
      expiration?: number;
      collapseId?: string;
    } = {}
  ): Promise<SendNotificationResponse> {
    const startTime = Date.now();
    const notificationId = generateUUID();
    const priority = options.priority || 10;

    notificationsInFlight.inc();

    try {
      const device = await tokenRegistry.lookupById(deviceId);

      if (!device || !device.is_valid) {
        notificationsInFlight.dec();
        throw new Error("Invalid device ID");
      }

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

      // Mark as processed for idempotency
      await markNotificationProcessed(notificationId);

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

      const status = result.delivered ? "delivered" : "queued";
      const latency = (Date.now() - startTime) / 1000;

      // Record metrics
      notificationsSent.inc({ priority: priority.toString(), status });
      notificationDeliveryLatency.observe({ priority: priority.toString() }, latency);

      logDelivery(notificationId, deviceId, status, {
        priority,
        latency_ms: Date.now() - startTime,
      });

      notificationsInFlight.dec();

      return {
        notification_id: notificationId,
        status,
      };
    } catch (error) {
      notificationsInFlight.dec();
      notificationsSent.inc({ priority: priority.toString(), status: "failed" });
      throw error;
    }
  }

  /**
   * Sends a notification to all devices subscribed to a topic.
   * Iterates through subscribers and sends individually to each device.
   *
   * @param topic - Topic name to broadcast to
   * @param payload - APNs notification payload
   * @param options - Delivery options (priority, expiration, collapse ID)
   * @returns Notification ID, status, and count of queued devices
   */
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

  /**
   * Attempts to deliver a notification to a device.
   * If device is online (connected via WebSocket), publishes for immediate delivery.
   * If offline, stores in pending queue for later delivery.
   *
   * @param notification - Pending notification to deliver
   * @returns Object indicating if notification was delivered or queued
   */
  private async deliverNotification(
    notification: PendingNotification
  ): Promise<{ delivered: boolean; queued: boolean }> {
    const { id, device_id, payload, priority, expiration, collapse_id: _collapse_id } =
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

  /**
   * Stores a notification for later delivery when device comes online.
   * Handles collapse ID deduplication by replacing older notifications.
   * Also enqueues by priority for background processing.
   *
   * @param notification - Notification to store
   */
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

  /**
   * Updates a notification's status in the database.
   *
   * @param notificationId - Notification UUID
   * @param status - New status to set
   */
  async updateNotificationStatus(
    notificationId: string,
    status: NotificationStatus
  ): Promise<void> {
    await db.query(
      `UPDATE notifications SET status = $2, updated_at = NOW() WHERE id = $1`,
      [notificationId, status]
    );
  }

  /**
   * Marks a notification as successfully delivered.
   * Creates a delivery log entry and removes from pending queue.
   * Called when device acknowledges receipt via WebSocket.
   *
   * @param notificationId - Notification UUID
   */
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

  /**
   * Gets all pending notifications for a device.
   * Excludes expired notifications, ordered by priority (high first) then age.
   *
   * @param deviceId - Device UUID
   * @returns Array of pending notifications
   */
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

  /**
   * Delivers all pending notifications when a device reconnects.
   * Called when device establishes WebSocket connection.
   *
   * @param deviceId - Device UUID
   * @returns Number of notifications delivered
   */
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

  /**
   * Retrieves a notification by its ID.
   *
   * @param notificationId - Notification UUID
   * @returns Notification record or null if not found
   */
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

  /**
   * Lists notifications with optional filters and pagination.
   * Used for admin dashboard notification list.
   *
   * @param options - Filter options (deviceId, status, limit, offset)
   * @returns Object with notifications array and total count
   */
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

  /**
   * Gets aggregate statistics about all notifications.
   * Used for admin dashboard overview.
   *
   * @returns Counts by status (total, pending, queued, delivered, failed, expired)
   */
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

  /**
   * Cleans up expired notifications from the system.
   * Updates status to "expired" and removes from pending queue.
   * Called periodically to prevent queue buildup.
   *
   * @returns Number of notifications cleaned up
   */
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

/**
 * Singleton instance of the Push Service.
 * Use this throughout the application for notification delivery.
 */
export const pushService = new PushService();
