import { Router, Request, Response } from "express";
import { tokenRegistry } from "../services/tokenRegistry.js";
import { pushService } from "../services/pushService.js";
import { feedbackService } from "../services/feedbackService.js";
import db from "../db/index.js";
import {
  generateUUID,
  hashPassword,
  verifyPassword,
  generateRandomToken,
  validateBundleId,
} from "../utils/index.js";
import { setSession, deleteSession } from "../db/redis.js";
import { requireAdmin } from "../shared/auth.js";
import { auditAdmin } from "../shared/logger.js";
import {
  createProviderKey,
  listProviderKeys,
  revokeProviderKey,
} from "../services/providerKeys.js";

/**
 * Admin Dashboard Routes.
 *
 * Provides authentication and administrative endpoints for the APNs management dashboard.
 * Includes session-based authentication and dashboard statistics.
 * Every route except login and logout requires an admin session.
 *
 * Routes:
 * - POST /login - Authenticate admin user
 * - POST /logout - End admin session
 * - GET /me - Get current user info
 * - GET /stats - Dashboard statistics
 * - GET /devices - List all devices (paginated)
 * - GET /notifications - List all notifications (paginated)
 * - GET /feedback - List all feedback (paginated)
 * - POST /broadcast - Send to all devices
 * - POST /cleanup - Clean up expired notifications
 * - POST /users - Create admin user
 * - POST /provider-keys - Issue a provider signing key (private key returned once)
 * - GET /provider-keys - List provider keys
 * - DELETE /provider-keys/:keyId - Revoke a provider key
 */
const router = Router();

/** Session time-to-live: 24 hours in seconds */
const SESSION_TTL = 24 * 60 * 60;

/**
 * Admin login endpoint.
 * Validates credentials and creates a session token.
 *
 * @route POST /api/v1/admin/login
 * @body {username, password}
 * @returns {token, user: {id, username, role}}
 */
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "BadRequest",
        message: "Username and password are required",
      });
    }

    // Look up user
    const result = await db.query<{
      id: string;
      username: string;
      password_hash: string;
      role: string;
    }>(
      `SELECT id, username, password_hash, role FROM admin_users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid credentials",
      });
    }

    const user = result.rows[0];

    // Verify password (simple hash for learning project)
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid credentials",
      });
    }

    // Create session
    const token = generateRandomToken();
    const sessionData = {
      user_id: user.id,
      username: user.username,
      role: user.role,
    };

    await setSession(token, sessionData, SESSION_TTL);

    // Update last login
    await db.query(
      `UPDATE admin_users SET last_login = NOW() WHERE id = $1`,
      [user.id]
    );

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error during login:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Login failed",
    });
  }
});

/**
 * Admin logout endpoint.
 * Deletes the session token from Redis.
 *
 * @route POST /api/v1/admin/logout
 * @header Authorization: Bearer <token>
 * @returns 204 No Content
 */
router.post("/logout", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      await deleteSession(token);
    }

    return res.status(204).send();
  } catch (error) {
    console.error("Error during logout:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Logout failed",
    });
  }
});

// Everything below requires an admin session (login and logout are above).
router.use(requireAdmin);

/**
 * Get current authenticated user.
 * Validates the session token and returns user info.
 *
 * @route GET /api/v1/admin/me
 * @header Authorization: Bearer <token>
 * @returns {id, username, role}
 */
router.get("/me", (req: Request, res: Response) => {
  const session = req.admin!;
  return res.json({
    id: session.user_id,
    username: session.username,
    role: session.role,
  });
});

/**
 * Get dashboard statistics.
 * Returns aggregate stats for notifications, devices, topics, and recent activity.
 *
 * @route GET /api/v1/admin/stats
 * @returns {notifications, devices, topics, recent_notifications}
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const [notificationStats, deviceStats, topicStats] = await Promise.all([
      pushService.getNotificationStats(),
      tokenRegistry.getDeviceStats(),
      tokenRegistry.getTopicStats(),
    ]);

    // Get recent notifications
    const { notifications: recentNotifications } = await pushService.getNotifications({
      limit: 10,
    });

    return res.json({
      notifications: notificationStats,
      devices: deviceStats,
      topics: topicStats,
      recent_notifications: recentNotifications,
    });
  } catch (error) {
    console.error("Error getting dashboard stats:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to get dashboard stats",
    });
  }
});

/**
 * List all registered devices with pagination.
 *
 * @route GET /api/v1/admin/devices
 * @query limit - Max results (default 100)
 * @query offset - Results to skip (default 0)
 * @returns {devices: DeviceToken[], total: number}
 */
router.get("/devices", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = req.query;

    const result = await tokenRegistry.getAllDevices(
      limit ? parseInt(limit as string, 10) : 100,
      offset ? parseInt(offset as string, 10) : 0
    );

    return res.json(result);
  } catch (error) {
    console.error("Error listing devices:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to list devices",
    });
  }
});

/**
 * List all notifications with pagination and filters.
 *
 * @route GET /api/v1/admin/notifications
 * @query device_id - Filter by device ID
 * @query status - Filter by status
 * @query limit - Max results (default 100)
 * @query offset - Results to skip (default 0)
 * @returns {notifications: Notification[], total: number}
 */
router.get("/notifications", async (req: Request, res: Response) => {
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
 * List all feedback entries with pagination.
 *
 * @route GET /api/v1/admin/feedback
 * @query limit - Max results (default 100)
 * @query offset - Results to skip (default 0)
 * @returns {feedback: FeedbackEntry[], total: number}
 */
router.get("/feedback", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = req.query;

    const result = await feedbackService.getAllFeedback(
      limit ? parseInt(limit as string, 10) : 100,
      offset ? parseInt(offset as string, 10) : 0
    );

    return res.json(result);
  } catch (error) {
    console.error("Error listing feedback:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to list feedback",
    });
  }
});

/**
 * Broadcast a notification to all valid devices.
 * Warning: This can send to many devices, use with caution.
 *
 * @route POST /api/v1/admin/broadcast
 * @body {payload, priority?, expiration?}
 * @returns {total_devices, sent, failed}
 */
router.post("/broadcast", async (req: Request, res: Response) => {
  try {
    const { payload, priority, expiration } = req.body;

    if (!payload || !payload.aps) {
      return res.status(400).json({
        error: "BadPayload",
        message: "Invalid notification payload",
      });
    }

    // Get all valid devices
    const { devices } = await tokenRegistry.getAllDevices(10000, 0);
    const validDevices = devices.filter((d) => d.is_valid);

    let sentCount = 0;
    let failedCount = 0;

    // Send to each device
    for (const device of validDevices) {
      try {
        await pushService.sendToDeviceById(device.device_id, payload, {
          priority: priority || 10,
          expiration,
        });
        sentCount++;
      } catch (_error) {
        failedCount++;
      }
    }

    return res.json({
      total_devices: validDevices.length,
      sent: sentCount,
      failed: failedCount,
    });
  } catch (error) {
    console.error("Error broadcasting notification:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to broadcast notification",
    });
  }
});

/**
 * Trigger cleanup of expired notifications.
 * Marks expired pending/queued notifications as expired.
 *
 * @route POST /api/v1/admin/cleanup
 * @returns {cleaned: number}
 */
router.post("/cleanup", async (req: Request, res: Response) => {
  try {
    const cleaned = await pushService.cleanupExpiredNotifications();

    return res.json({
      cleaned,
    });
  } catch (error) {
    console.error("Error cleaning up notifications:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to cleanup notifications",
    });
  }
});

/**
 * Create a new admin user.
 * Only accessible by existing admins.
 *
 * @route POST /api/v1/admin/users
 * @body {username, password, role?}
 * @returns {id, username, role}
 */
router.post("/users", async (req: Request, res: Response) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "BadRequest",
        message: "Username and password are required",
      });
    }

    const userId = generateUUID();
    const passwordHash = hashPassword(password);

    await db.query(
      `INSERT INTO admin_users (id, username, password_hash, role)
       VALUES ($1, $2, $3, $4)`,
      [userId, username, passwordHash, role || "admin"]
    );

    auditAdmin("admin_user_created", req.admin!.user_id, { username });

    return res.status(201).json({
      id: userId,
      username,
      role: role || "admin",
    });
  } catch (error) {
    console.error("Error creating admin user:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to create admin user",
    });
  }
});

/** Team and key IDs follow the APNs 10-character format. */
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * Issue a provider signing key scoped to a set of apps.
 * The private key is in this response only; the server keeps the public key.
 *
 * @route POST /api/v1/admin/provider-keys
 * @body {team_id, app_bundle_ids: string[]}
 * @returns {key_id, team_id, app_bundle_ids, created_at, private_key}
 */
router.post("/provider-keys", async (req: Request, res: Response) => {
  try {
    const { team_id, app_bundle_ids } = req.body ?? {};

    if (typeof team_id !== "string" || !TEAM_ID_PATTERN.test(team_id)) {
      return res.status(400).json({
        error: "BadRequest",
        message: "team_id must be 10 uppercase letters or digits",
      });
    }

    if (
      !Array.isArray(app_bundle_ids) ||
      app_bundle_ids.length === 0 ||
      !app_bundle_ids.every((id) => typeof id === "string" && validateBundleId(id))
    ) {
      return res.status(400).json({
        error: "BadRequest",
        message: "app_bundle_ids must be a non-empty array of bundle IDs",
      });
    }

    const key = await createProviderKey(team_id, app_bundle_ids, req.admin!.user_id);

    auditAdmin("provider_key_created", req.admin!.user_id, {
      key_id: key.key_id,
      team_id,
      app_bundle_ids,
    });

    return res.status(201).json(key);
  } catch (error) {
    console.error("Error creating provider key:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to create provider key",
    });
  }
});

/**
 * List provider keys (metadata only).
 *
 * @route GET /api/v1/admin/provider-keys
 * @returns {keys: ProviderKeySummary[]}
 */
router.get("/provider-keys", async (req: Request, res: Response) => {
  try {
    return res.json({ keys: await listProviderKeys() });
  } catch (error) {
    console.error("Error listing provider keys:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to list provider keys",
    });
  }
});

/**
 * Revoke a provider key. Tokens it signed stop verifying immediately.
 *
 * @route DELETE /api/v1/admin/provider-keys/:keyId
 * @returns 204 No Content, or 404 if no active key has that ID
 */
router.delete("/provider-keys/:keyId", async (req: Request, res: Response) => {
  try {
    const revoked = await revokeProviderKey(req.params.keyId);

    if (!revoked) {
      return res.status(404).json({
        error: "NotFound",
        message: "No active provider key with that ID",
      });
    }

    auditAdmin("provider_key_revoked", req.admin!.user_id, {
      key_id: req.params.keyId,
    });

    return res.status(204).send();
  } catch (error) {
    console.error("Error revoking provider key:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to revoke provider key",
    });
  }
});

export default router;
