/**
 * APNs Backend Server Entry Point.
 *
 * This is the main entry point for the Apple Push Notification service clone.
 * It sets up an Express HTTP server with WebSocket support for real-time
 * device connections and notification delivery.
 *
 * Key features:
 * - REST API for device registration and notification sending
 * - WebSocket server for persistent device connections
 * - Redis pub/sub for cross-server notification routing
 * - Periodic cleanup of expired notifications
 *
 * @module index
 */

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

import db from "./db/index.js";
import redis, {
  setDeviceConnected,
  removeDeviceConnection,
  subscribeToNotifications,
  checkConnection as checkRedisConnection,
} from "./db/redis.js";
import { checkConnection as checkDbConnection } from "./db/index.js";

import devicesRouter from "./routes/devices.js";
import notificationsRouter from "./routes/notifications.js";
import feedbackRouter from "./routes/feedback.js";
import adminRouter from "./routes/admin.js";

import { pushService } from "./services/pushService.js";
import { WSMessage, WSConnect, WSAck } from "./types/index.js";

const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || "3000", 10);

/** Unique server identifier for pub/sub routing */
const SERVER_ID = `server-${PORT}`;

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Request logging middleware.
 * Logs method, path, status code, and duration for each request.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

/**
 * Health check endpoint.
 * Returns the status of database and Redis connections.
 *
 * @route GET /health
 */
app.get("/health", async (req: Request, res: Response) => {
  const dbHealthy = await checkDbConnection();
  const redisHealthy = await checkRedisConnection();

  const status = dbHealthy && redisHealthy ? 200 : 503;

  return res.status(status).json({
    status: status === 200 ? "healthy" : "unhealthy",
    server_id: SERVER_ID,
    services: {
      database: dbHealthy ? "connected" : "disconnected",
      redis: redisHealthy ? "connected" : "disconnected",
    },
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use("/api/v1/devices", devicesRouter);
app.use("/api/v1/notifications", notificationsRouter);
app.use("/api/v1/feedback", feedbackRouter);
app.use("/api/v1/admin", adminRouter);

/**
 * APNs-style endpoint for sending notifications.
 * Mimics the real APNs HTTP/2 endpoint format.
 * Reads priority and expiration from custom headers.
 *
 * @route POST /3/device/:deviceToken
 * @header apns-priority - Notification priority (1, 5, or 10)
 * @header apns-expiration - Unix timestamp expiration
 * @header apns-collapse-id - Collapse ID for deduplication
 */
app.post("/3/device/:deviceToken", async (req: Request, res: Response) => {
  try {
    const { deviceToken } = req.params;
    const payload = req.body;
    const priority = parseInt(req.headers["apns-priority"] as string || "10", 10);
    const expiration = parseInt(req.headers["apns-expiration"] as string || "0", 10);
    const collapseId = req.headers["apns-collapse-id"] as string | undefined;

    const result = await pushService.sendToDevice(deviceToken, payload, {
      priority: priority as 1 | 5 | 10,
      expiration: expiration > 0 ? expiration : undefined,
      collapseId,
    });

    res.setHeader("apns-id", result.notification_id);
    return res.status(200).json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage === "Unregistered device token") {
      return res.status(410).json({ reason: "Unregistered" });
    }

    console.error("Error sending notification:", error);
    return res.status(500).json({ reason: "InternalServerError" });
  }
});

/**
 * Global error handling middleware.
 * Catches unhandled errors and returns a 500 response.
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: "InternalServerError",
    message: "An unexpected error occurred",
  });
});

/**
 * 404 handler for unmatched routes.
 */
app.use((req: Request, res: Response) => {
  return res.status(404).json({
    error: "NotFound",
    message: "The requested resource was not found",
  });
});

// Create HTTP server
const server = http.createServer(app);

/**
 * WebSocket server for device connections.
 * Devices connect here to receive push notifications in real-time.
 * Path: /ws
 */
const wss = new WebSocketServer({ server, path: "/ws" });

/** Map of connected devices: deviceId -> WebSocket */
const deviceConnections = new Map<string, WebSocket>();

/**
 * Handle new WebSocket connections.
 * Devices send a 'connect' message with their device_id to register.
 * Server delivers pending notifications upon connection.
 */
wss.on("connection", (ws: WebSocket) => {
  let deviceId: string | null = null;

  console.log("WebSocket client connected");

  ws.on("message", async (data: Buffer) => {
    try {
      const message: WSMessage = JSON.parse(data.toString());

      switch (message.type) {
        case "connect": {
          const connectMsg = message as WSConnect;
          deviceId = connectMsg.device_id;

          if (deviceId) {
            deviceConnections.set(deviceId, ws);
            await setDeviceConnected(deviceId, SERVER_ID);

            // Deliver pending notifications
            const deliveredCount = await pushService.deliverPendingToDevice(deviceId);

            ws.send(
              JSON.stringify({
                type: "connected",
                device_id: deviceId,
                pending_delivered: deliveredCount,
              })
            );

            console.log(`Device ${deviceId} connected, delivered ${deliveredCount} pending`);
          }
          break;
        }

        case "ack": {
          const ackMsg = message as WSAck;
          await pushService.markDelivered(ackMsg.notification_id);
          console.log(`Notification ${ackMsg.notification_id} acknowledged`);
          break;
        }

        default:
          console.log("Unknown message type:", message.type);
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });

  ws.on("close", async () => {
    if (deviceId) {
      deviceConnections.delete(deviceId);
      await removeDeviceConnection(deviceId);
      console.log(`Device ${deviceId} disconnected`);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

/**
 * Subscribe to Redis pub/sub for cross-server notification delivery.
 * When a notification needs to be delivered to a device connected to this server,
 * the message comes through this channel.
 */
subscribeToNotifications(`notifications:${SERVER_ID}`, (message: unknown) => {
  const msg = message as {
    type: string;
    notification_id: string;
    device_id: string;
    payload: unknown;
    priority: number;
  };

  if (msg.type === "push") {
    const ws = deviceConnections.get(msg.device_id);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "notification",
          id: msg.notification_id,
          payload: msg.payload,
          priority: msg.priority,
        })
      );
      console.log(`Pushed notification ${msg.notification_id} to device ${msg.device_id}`);
    }
  }
});

/**
 * Periodic cleanup task.
 * Runs every minute to mark expired notifications and clean up pending queue.
 */
setInterval(async () => {
  try {
    const cleaned = await pushService.cleanupExpiredNotifications();
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired notifications`);
    }
  } catch (error) {
    console.error("Error cleaning up expired notifications:", error);
  }
}, 60000); // Every minute

// Start server
server.listen(PORT, () => {
  console.log(`APNs Server ${SERVER_ID} listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API base: http://localhost:${PORT}/api/v1`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});

/**
 * Graceful shutdown handler.
 * Closes HTTP server, WebSocket server, and database connections.
 */
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully...");

  server.close(() => {
    console.log("HTTP server closed");
  });

  wss.close(() => {
    console.log("WebSocket server closed");
  });

  await redis.quit();
  await db.pool.end();

  process.exit(0);
});

export default app;
