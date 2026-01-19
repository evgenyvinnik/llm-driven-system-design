import { Router, Request, Response } from "express";
import { pushService } from "../services/pushService.js";
import {
  validateDeviceToken,
  validatePayload,
  validatePriority,
  validateTopic,
} from "../utils/index.js";
import { SendNotificationRequest, NotificationPriority } from "../types/index.js";

/**
 * Notification Routes.
 *
 * Handles sending push notifications to devices and topics.
 * Provides status checking and notification listing endpoints.
 *
 * Routes:
 * - POST /device/:deviceToken - Send to device by token
 * - POST /device-id/:deviceId - Send to device by ID
 * - POST /topic/:topic - Send to topic subscribers
 * - GET /:notificationId - Get notification details
 * - GET / - List notifications with filters
 * - GET /:notificationId/status - Get notification status
 */
const router = Router();

/**
 * Send a notification to a device by its raw token.
 * Creates a notification record and attempts delivery.
 *
 * @route POST /api/v1/notifications/device/:deviceToken
 * @param deviceToken - 64-character hex device token
 * @body {payload, priority?, expiration?, collapse_id?}
 * @returns {notification_id, status}
 */
router.post("/device/:deviceToken", async (req: Request, res: Response) => {
  try {
    const { deviceToken } = req.params;
    const { payload, priority, expiration, collapse_id } =
      req.body as SendNotificationRequest;

    if (!validateDeviceToken(deviceToken)) {
      return res.status(400).json({
        error: "InvalidToken",
        message: "Invalid device token format",
      });
    }

    if (!payload || !validatePayload(payload)) {
      return res.status(400).json({
        error: "BadPayload",
        message: "Invalid notification payload",
      });
    }

    const notificationPriority: NotificationPriority =
      priority && validatePriority(priority) ? priority : 10;

    const result = await pushService.sendToDevice(deviceToken, payload, {
      priority: notificationPriority,
      expiration,
      collapseId: collapse_id,
    });

    return res.status(200).json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage === "Unregistered device token") {
      return res.status(410).json({
        error: "Unregistered",
        message: "Device token is not registered or has been invalidated",
      });
    }

    console.error("Error sending notification:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to send notification",
    });
  }
});

/**
 * Send a notification to a device by its server-assigned ID.
 * Similar to token-based sending but uses internal device ID.
 *
 * @route POST /api/v1/notifications/device-id/:deviceId
 * @param deviceId - UUID device identifier
 * @body {payload, priority?, expiration?, collapse_id?}
 * @returns {notification_id, status}
 */
router.post("/device-id/:deviceId", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { payload, priority, expiration, collapse_id } =
      req.body as SendNotificationRequest;

    if (!payload || !validatePayload(payload)) {
      return res.status(400).json({
        error: "BadPayload",
        message: "Invalid notification payload",
      });
    }

    const notificationPriority: NotificationPriority =
      priority && validatePriority(priority) ? priority : 10;

    const result = await pushService.sendToDeviceById(deviceId, payload, {
      priority: notificationPriority,
      expiration,
      collapseId: collapse_id,
    });

    return res.status(200).json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage === "Invalid device ID") {
      return res.status(404).json({
        error: "NotFound",
        message: "Device not found or invalid",
      });
    }

    console.error("Error sending notification:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to send notification",
    });
  }
});

/**
 * Send a notification to all subscribers of a topic.
 * Queues notifications for all valid devices subscribed to the topic.
 *
 * @route POST /api/v1/notifications/topic/:topic
 * @param topic - Topic name
 * @body {payload, priority?, expiration?, collapse_id?}
 * @returns {notification_id, status, queued_count}
 */
router.post("/topic/:topic", async (req: Request, res: Response) => {
  try {
    const { topic } = req.params;
    const { payload, priority, expiration, collapse_id } =
      req.body as SendNotificationRequest;

    if (!validateTopic(topic)) {
      return res.status(400).json({
        error: "InvalidTopic",
        message: "Invalid topic format",
      });
    }

    if (!payload || !validatePayload(payload)) {
      return res.status(400).json({
        error: "BadPayload",
        message: "Invalid notification payload",
      });
    }

    const notificationPriority: NotificationPriority =
      priority && validatePriority(priority) ? priority : 10;

    const result = await pushService.sendToTopic(topic, payload, {
      priority: notificationPriority,
      expiration,
      collapseId: collapse_id,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("Error sending topic notification:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to send topic notification",
    });
  }
});

/**
 * Get a notification by its ID.
 * Returns full notification details including payload.
 *
 * @route GET /api/v1/notifications/:notificationId
 * @param notificationId - UUID notification identifier
 * @returns Notification record
 */
router.get("/:notificationId", async (req: Request, res: Response) => {
  try {
    const { notificationId } = req.params;

    const notification = await pushService.getNotification(notificationId);

    if (!notification) {
      return res.status(404).json({
        error: "NotFound",
        message: "Notification not found",
      });
    }

    return res.json(notification);
  } catch (error) {
    console.error("Error getting notification:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to get notification",
    });
  }
});

/**
 * List notifications with optional filters.
 * Supports filtering by device ID and status, with pagination.
 *
 * @route GET /api/v1/notifications
 * @query device_id - Filter by device ID
 * @query status - Filter by status (pending, queued, delivered, failed, expired)
 * @query limit - Max results (default 100)
 * @query offset - Results to skip (default 0)
 * @returns {notifications: Notification[], total: number}
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const { device_id, status, limit, offset } = req.query;

    const result = await pushService.getNotifications({
      deviceId: device_id as string | undefined,
      status: status as "pending" | "queued" | "delivered" | "failed" | "expired" | undefined,
      limit: limit ? parseInt(limit as string, 10) : 100,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });

    return res.json(result);
  } catch (error) {
    console.error("Error listing notifications:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to list notifications",
    });
  }
});

/**
 * Get just the status of a notification.
 * Lighter weight than fetching the full notification.
 *
 * @route GET /api/v1/notifications/:notificationId/status
 * @param notificationId - UUID notification identifier
 * @returns {notification_id, status, created_at, updated_at}
 */
router.get("/:notificationId/status", async (req: Request, res: Response) => {
  try {
    const { notificationId } = req.params;

    const notification = await pushService.getNotification(notificationId);

    if (!notification) {
      return res.status(404).json({
        error: "NotFound",
        message: "Notification not found",
      });
    }

    return res.json({
      notification_id: notification.id,
      status: notification.status,
      created_at: notification.created_at,
      updated_at: notification.updated_at,
    });
  } catch (error) {
    console.error("Error getting notification status:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to get notification status",
    });
  }
});

export default router;
