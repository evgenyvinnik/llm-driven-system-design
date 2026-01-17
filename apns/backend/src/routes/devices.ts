import { Router, Request, Response } from "express";
import { tokenRegistry } from "../services/tokenRegistry.js";
import {
  validateDeviceToken,
  validateBundleId,
  validateTopic,
} from "../utils/index.js";
import {
  RegisterDeviceRequest,
  SubscribeTopicRequest,
} from "../types/index.js";

const router = Router();

// Register a device token
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

// Get device by token
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

// Get device by ID
router.get("/:deviceId", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;

    const device = await tokenRegistry.lookupById(deviceId);

    if (!device) {
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

// Invalidate a device token
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

// Subscribe to a topic
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

// Unsubscribe from a topic
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

// Get device subscriptions
router.get("/:deviceId/topics", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;

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
