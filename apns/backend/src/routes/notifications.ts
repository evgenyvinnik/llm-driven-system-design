import { Router, Request, Response } from "express";
import { pushService } from "../services/pushService.js";
import { tokenRegistry } from "../services/tokenRegistry.js";
import {
  validateDeviceToken,
  validatePayload,
  validatePriority,
  validateTopic,
} from "../utils/index.js";
import { SendNotificationRequest, NotificationPriority } from "../types/index.js";

const router = Router();

// Send notification to a device by token
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

// Send notification to a device by ID
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

// Send notification to a topic
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

// Get notification by ID
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

// List notifications with filters
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

// Get notification delivery status
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
