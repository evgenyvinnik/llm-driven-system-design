import { Router, Request, Response } from "express";
import { tokenRegistry } from "../services/tokenRegistry.js";
import { requireProvider, canAccessBundle } from "../shared/auth.js";
import {
  validateDeviceToken,
  validateBundleId,
  validateTopic,
} from "../utils/index.js";
import {
  RegisterDeviceRequest,
  SubscribeTopicRequest,
} from "../types/index.js";

/**
 * Device Management Routes.
 *
 * Handles device token registration, lookup, invalidation, and topic subscriptions.
 * These endpoints are called by iOS apps and backend services.
 *
 * Routes keyed by the raw token are authorized by possession of that token —
 * it is the device's secret, stored only as a hash. Routes keyed by the
 * server-assigned device ID need a provider JWT covering the device's app (or
 * an admin session), because device IDs are not secret.
 *
 * Routes:
 * - POST /register - Register a device token
 * - GET /token/:token - Look up device by raw token
 * - GET /:deviceId - Look up device by ID
 * - DELETE /token/:token - Invalidate a device token
 * - POST /topics/subscribe - Subscribe device to topic
 * - POST /topics/unsubscribe - Unsubscribe device from topic
 * - GET /:deviceId/topics - Get device's topic subscriptions
 */
const router = Router();

/**
 * Register a device token.
 * Called by iOS apps when they receive a device token from APNs.
 * Creates a new device or updates last_seen for existing devices.
 *
 * @route POST /api/v1/devices/register
 * @body {token, app_bundle_id, device_info?}
 * @returns {device_id, is_new}
 */
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { token, app_bundle_id, device_info } = req.body as RegisterDeviceRequest;

    // Validate token format
    if (!token || !validateDeviceToken(token)) {
      return res.status(400).json({
        error: "InvalidToken",
        message: "Device token must be a 64-character hex string",
      });
    }

    // Validate bundle ID
    if (!app_bundle_id || !validateBundleId(app_bundle_id)) {
      return res.status(400).json({
        error: "InvalidBundleId",
        message: "Invalid app bundle ID format",
      });
    }

    const result = await tokenRegistry.registerToken(
      token,
      app_bundle_id,
      device_info
    );

    return res.status(result.is_new ? 201 : 200).json(result);
  } catch (error) {
    console.error("Error registering device:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to register device",
    });
  }
});

/**
 * Look up a device by its raw token.
 * Returns device info if found and valid.
 *
 * @route GET /api/v1/devices/token/:token
 * @param token - 64-character hex device token
 * @returns Device record
 */
router.get("/token/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    if (!validateDeviceToken(token)) {
      return res.status(400).json({
        error: "InvalidToken",
        message: "Invalid device token format",
      });
    }

    const device = await tokenRegistry.lookup(token);

    if (!device) {
      return res.status(404).json({
        error: "NotFound",
        message: "Device token not found or invalid",
      });
    }

    return res.json(device);
  } catch (error) {
    console.error("Error looking up device:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to lookup device",
    });
  }
});

/**
 * Look up a device by its server-assigned ID.
 * Returns device info including validity status.
 *
 * @route GET /api/v1/devices/:deviceId
 * @param deviceId - UUID device identifier
 * @returns Device record
 */
router.get("/:deviceId", requireProvider(), async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;

    const device = await tokenRegistry.lookupById(deviceId);

    if (!device || !canAccessBundle(req.principal, device.app_bundle_id)) {
      return res.status(404).json({
        error: "NotFound",
        message: "Device not found",
      });
    }

    return res.json(device);
  } catch (error) {
    console.error("Error looking up device:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to lookup device",
    });
  }
});

/**
 * Invalidate a device token.
 * Marks the token as invalid and adds to feedback queue.
 * Called when an app uninstalls or token is known to be invalid.
 *
 * @route DELETE /api/v1/devices/token/:token
 * @param token - 64-character hex device token
 * @body {reason?} - Optional invalidation reason
 * @returns 204 No Content
 */
router.delete("/token/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { reason } = req.body || {};

    if (!validateDeviceToken(token)) {
      return res.status(400).json({
        error: "InvalidToken",
        message: "Invalid device token format",
      });
    }

    await tokenRegistry.invalidateToken(token, reason || "ManualInvalidation");

    return res.status(204).send();
  } catch (error) {
    console.error("Error invalidating device:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to invalidate device",
    });
  }
});

/**
 * Subscribe a device to a topic.
 * Enables the device to receive notifications sent to this topic.
 *
 * @route POST /api/v1/devices/topics/subscribe
 * @body {device_token, topic}
 * @returns {success: true, topic}
 */
router.post("/topics/subscribe", async (req: Request, res: Response) => {
  try {
    const { device_token, topic } = req.body as SubscribeTopicRequest;

    if (!device_token || !validateDeviceToken(device_token)) {
      return res.status(400).json({
        error: "InvalidToken",
        message: "Invalid device token format",
      });
    }

    if (!topic || !validateTopic(topic)) {
      return res.status(400).json({
        error: "InvalidTopic",
        message: "Invalid topic format",
      });
    }

    await tokenRegistry.subscribeToTopic(device_token, topic);

    return res.status(200).json({ success: true, topic });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage === "Invalid token") {
      return res.status(404).json({
        error: "NotFound",
        message: "Device token not found or invalid",
      });
    }

    console.error("Error subscribing to topic:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to subscribe to topic",
    });
  }
});

/**
 * Unsubscribe a device from a topic.
 * Device will no longer receive notifications for this topic.
 *
 * @route POST /api/v1/devices/topics/unsubscribe
 * @body {device_token, topic}
 * @returns {success: true}
 */
router.post("/topics/unsubscribe", async (req: Request, res: Response) => {
  try {
    const { device_token, topic } = req.body as SubscribeTopicRequest;

    if (!device_token || !validateDeviceToken(device_token)) {
      return res.status(400).json({
        error: "InvalidToken",
        message: "Invalid device token format",
      });
    }

    if (!topic || !validateTopic(topic)) {
      return res.status(400).json({
        error: "InvalidTopic",
        message: "Invalid topic format",
      });
    }

    await tokenRegistry.unsubscribeFromTopic(device_token, topic);

    return res.status(200).json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage === "Invalid token") {
      return res.status(404).json({
        error: "NotFound",
        message: "Device token not found or invalid",
      });
    }

    console.error("Error unsubscribing from topic:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to unsubscribe from topic",
    });
  }
});

/**
 * Get all topics a device is subscribed to.
 *
 * @route GET /api/v1/devices/:deviceId/topics
 * @param deviceId - UUID device identifier
 * @returns {device_id, topics: string[]}
 */
router.get("/:deviceId/topics", requireProvider(), async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;

    const device = await tokenRegistry.lookupById(deviceId);
    if (!device || !canAccessBundle(req.principal, device.app_bundle_id)) {
      return res.status(404).json({
        error: "NotFound",
        message: "Device not found",
      });
    }

    const topics = await tokenRegistry.getDeviceTopics(deviceId);

    return res.json({ device_id: deviceId, topics });
  } catch (error) {
    console.error("Error getting device topics:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to get device topics",
    });
  }
});

export default router;
