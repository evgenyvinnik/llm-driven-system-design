import { Router, Request, Response } from "express";
import { tokenRegistry } from "../services/tokenRegistry.js";
import { pushService } from "../services/pushService.js";
import { feedbackService } from "../services/feedbackService.js";
import db from "../db/index.js";
import { generateUUID, hashPassword, verifyPassword, generateRandomToken } from "../utils/index.js";
import { setSession, getSession, deleteSession } from "../db/redis.js";

/**
 * Admin Dashboard Routes.
 *
 * Provides authentication and administrative endpoints for the APNs management dashboard.
 * Includes session-based authentication and dashboard statistics.
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

/**
 * Get current authenticated user.
 * Validates the session token and returns user info.
 *
 * @route GET /api/v1/admin/me
 * @header Authorization: Bearer <token>
 * @returns {id, username, role}
 */
router.get("/me", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required",
      });
    }

    const token = authHeader.substring(7);
    const session = await getSession<{
      user_id: string;
      username: string;
      role: string;
    }>(token);

    if (!session) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired session",
      });
    }

    return res.json({
      id: session.user_id,
      username: session.username,
      role: session.role,
    });
  } catch (error) {
    console.error("Error getting current user:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to get current user",
    });
  }
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
      } catch (error) {
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

export default router;
