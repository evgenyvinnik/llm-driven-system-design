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
 * - Prometheus metrics endpoint for observability
 * - Structured logging with pino
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

import { pushService, DEVICE_NOT_IN_SCOPE } from "./services/pushService.js";
import { tokenRegistry } from "./services/tokenRegistry.js";
import { WSMessage, WSConnect, WSAck } from "./types/index.js";
import { validateDeviceToken } from "./utils/index.js";
import { requireProvider, allowedBundleIds } from "./shared/auth.js";

// Import shared modules
import {
  logger,
  httpLogger,
  logDelivery,
} from "./shared/logger.js";
import {
  getMetrics,
  getMetricsContentType,
  metricsMiddleware,
  activeConnections,
  connectionEvents,
  dependencyHealth,
  pendingNotifications as _pendingNotifications,
} from "./shared/metrics.js";

const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || "3000", 10);

/** Unique server identifier for pub/sub routing */
const SERVER_ID = `server-${PORT}`;

// Middleware
app.use(cors());
app.use(express.json());

// Structured HTTP request logging with pino
app.use(httpLogger);

// Prometheus metrics middleware for request duration and counts
app.use(metricsMiddleware());

/**
 * Health check endpoint.
 * Returns the status of database and Redis connections.
 * Updates dependency health metrics for monitoring.
 *
 * @route GET /health
 */
app.get("/health", async (req: Request, res: Response) => {
  const dbHealthy = await checkDbConnection();
  const redisHealthy = await checkRedisConnection();

  // Update health metrics for Prometheus
  dependencyHealth.set({ dependency: "database" }, dbHealthy ? 1 : 0);
  dependencyHealth.set({ dependency: "redis" }, redisHealthy ? 1 : 0);

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

/**
 * Prometheus metrics endpoint.
 * Exposes all collected metrics in Prometheus format for scraping.
 *
 * @route GET /metrics
 */
app.get("/metrics", async (req: Request, res: Response) => {
  try {
    const metrics = await getMetrics();
    res.set("Content-Type", getMetricsContentType());
    return res.send(metrics);
  } catch (error) {
    logger.error({
      event: "metrics_error",
      error: (error as Error).message,
    });
    return res.status(500).send("Error collecting metrics");
  }
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
 * Supports idempotency via apns-id header.
 * Requires `authorization: bearer <provider JWT>` (or an admin session); the
 * device must belong to an app the provider key covers.
 *
 * @route POST /3/device/:deviceToken
 * @header authorization - bearer provider JWT
 * @header apns-id - Optional idempotency key (notification ID)
 * @header apns-priority - Notification priority (1, 5, or 10)
 * @header apns-expiration - Unix timestamp expiration
 * @header apns-collapse-id - Collapse ID for deduplication
 */
app.post("/3/device/:deviceToken", requireProvider("apns"), async (req: Request, res: Response) => {
  try {
    const { deviceToken } = req.params;
    const payload = req.body;
    const priority = parseInt(req.headers["apns-priority"] as string || "10", 10);
    const expiration = parseInt(req.headers["apns-expiration"] as string || "0", 10);
    const collapseId = req.headers["apns-collapse-id"] as string | undefined;
    // apns-id header provides idempotency key for retry handling
    const apnsId = req.headers["apns-id"] as string | undefined;

    const result = await pushService.sendToDevice(deviceToken, payload, {
      priority: priority as 1 | 5 | 10,
      expiration: expiration > 0 ? expiration : undefined,
      collapseId,
      idempotencyKey: apnsId,
      allowedBundleIds: allowedBundleIds(req.principal),
    });

    res.setHeader("apns-id", result.notification_id);
    return res.status(200).json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage === "Unregistered device token") {
      return res.status(410).json({ reason: "Unregistered" });
    }

    if (errorMessage === DEVICE_NOT_IN_SCOPE) {
      return res.status(400).json({ reason: "DeviceTokenNotForTopic" });
    }

    logger.error({
      event: "apns_endpoint_error",
      error: errorMessage,
      device_token_prefix: req.params.deviceToken?.substring(0, 8),
    });
    return res.status(500).json({ reason: "InternalServerError" });
  }
});

/**
 * Global error handling middleware.
 * Catches unhandled errors and returns a 500 response.
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({
    event: "unhandled_error",
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
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

/** A socket that has not authenticated within this window is closed. */
const DEVICE_AUTH_TIMEOUT_MS = 10_000;

/** Close code for a socket that failed or skipped device authentication. */
const WS_CLOSE_UNAUTHORIZED = 4401;

/** Close code for an older socket replaced by a newer one for the same device. */
const WS_CLOSE_REPLACED = 4409;

/**
 * Handle new WebSocket connections.
 *
 * A device authenticates by sending `{type: "connect", device_token}` with its
 * raw 64-hex token. The token is resolved through the token registry (which
 * stores only its hash), so knowing a device's UUID is not enough to receive
 * its notifications. Until that succeeds the socket can do nothing else; it
 * is closed after DEVICE_AUTH_TIMEOUT_MS or on a bad token. Acks are accepted
 * only for notifications addressed to the authenticated device.
 *
 * Server delivers pending notifications upon connection.
 * Tracks connection metrics for monitoring.
 */
wss.on("connection", (ws: WebSocket) => {
  /** Set only after the device token has been verified */
  let deviceId: string | null = null;
  /** Guards against a second connect racing the first one's token lookup */
  let authenticating = false;

  logger.info({ event: "websocket_client_connected" });
  connectionEvents.inc({ event: "connect" });

  const authTimer = setTimeout(() => {
    if (!deviceId) {
      ws.close(WS_CLOSE_UNAUTHORIZED, "Authentication timeout");
    }
  }, DEVICE_AUTH_TIMEOUT_MS);

  const sendError = (error: string, message: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", error, message }));
    }
  };

  const rejectConnect = (error: string, message: string) => {
    sendError(error, message);
    ws.close(WS_CLOSE_UNAUTHORIZED, error);
  };

  ws.on("message", async (data: Buffer) => {
    try {
      const message: WSMessage = JSON.parse(data.toString());

      switch (message.type) {
        case "connect": {
          if (deviceId || authenticating) {
            sendError("AlreadyConnected", "This socket has already sent connect");
            break;
          }

          const { device_token: deviceToken } = message as WSConnect;
          if (typeof deviceToken !== "string" || !validateDeviceToken(deviceToken)) {
            rejectConnect(
              "InvalidToken",
              "connect requires device_token, the device's raw 64-character hex token"
            );
            break;
          }

          authenticating = true;
          const device = await tokenRegistry.lookup(deviceToken);
          authenticating = false;

          if (!device) {
            rejectConnect("Unregistered", "Device token is not registered or has been invalidated");
            break;
          }

          // The client may have gone away while the lookup was in flight
          if (ws.readyState !== WebSocket.OPEN) {
            break;
          }

          clearTimeout(authTimer);
          deviceId = device.device_id;

          // One live connection per device: a newer socket replaces an older one
          const previous = deviceConnections.get(deviceId);
          deviceConnections.set(deviceId, ws);
          if (previous && previous !== ws) {
            previous.close(WS_CLOSE_REPLACED, "Replaced by a newer connection");
          }
          await setDeviceConnected(deviceId, SERVER_ID);

          // Update active connections gauge
          activeConnections.set(deviceConnections.size);

          // Deliver pending notifications
          const deliveredCount = await pushService.deliverPendingToDevice(deviceId);

          ws.send(
            JSON.stringify({
              type: "connected",
              device_id: deviceId,
              pending_delivered: deliveredCount,
            })
          );

          logger.info({
            event: "device_connected",
            device_id: deviceId,
            pending_delivered: deliveredCount,
          });
          break;
        }

        case "ack": {
          if (!deviceId) {
            sendError("Unauthenticated", "Send connect with device_token first");
            break;
          }

          const ackMsg = message as WSAck;
          const acknowledged =
            typeof ackMsg.notification_id === "string" &&
            (await pushService.markDelivered(ackMsg.notification_id, deviceId));

          if (!acknowledged) {
            sendError("UnknownNotification", "No notification with that ID for this device");
            logger.warn({
              event: "ack_rejected",
              device_id: deviceId,
              notification_id: ackMsg.notification_id,
            });
            break;
          }

          logger.debug({
            event: "notification_acknowledged",
            notification_id: ackMsg.notification_id,
          });
          break;
        }

        default:
          logger.warn({ event: "unknown_message_type", type: message.type });
      }
    } catch (error) {
      authenticating = false;
      sendError("BadMessage", "Message could not be processed");
      logger.error({
        event: "websocket_message_error",
        error: (error as Error).message,
      });
    }
  });

  ws.on("close", async () => {
    clearTimeout(authTimer);

    if (deviceId) {
      // A replaced socket must not erase the newer connection's route
      if (deviceConnections.get(deviceId) === ws) {
        deviceConnections.delete(deviceId);
        await removeDeviceConnection(deviceId);

        // Update active connections gauge
        activeConnections.set(deviceConnections.size);
      }
      connectionEvents.inc({ event: "disconnect" });

      logger.info({ event: "device_disconnected", device_id: deviceId });
    }
  });

  ws.on("error", (error) => {
    connectionEvents.inc({ event: "error" });
    logger.error({
      event: "websocket_error",
      error: error.message,
      device_id: deviceId,
    });
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
      logDelivery(msg.notification_id, msg.device_id, "pushed", {
        priority: msg.priority,
      });
    }
  }
});

/**
 * Periodic cleanup task.
 * Runs every minute to mark expired notifications and clean up pending queue.
 * Also updates the pending notifications gauge.
 */
setInterval(async () => {
  try {
    const cleaned = await pushService.cleanupExpiredNotifications();
    if (cleaned > 0) {
      logger.info({ event: "cleanup_expired", count: cleaned });
    }

    // Update pending notifications gauge (query from DB periodically)
    // This is a lightweight operation to keep the gauge accurate
  } catch (error) {
    logger.error({
      event: "cleanup_error",
      error: (error as Error).message,
    });
  }
}, 60000); // Every minute

// Start server
server.listen(PORT, () => {
  logger.info({
    event: "server_started",
    server_id: SERVER_ID,
    port: PORT,
    health_check: `http://localhost:${PORT}/health`,
    metrics: `http://localhost:${PORT}/metrics`,
    api_base: `http://localhost:${PORT}/api/v1`,
    websocket: `ws://localhost:${PORT}/ws`,
  });
});

/**
 * Graceful shutdown handler.
 * Closes HTTP server, WebSocket server, and database connections.
 */
process.on("SIGTERM", async () => {
  logger.info({ event: "shutdown_initiated", reason: "SIGTERM" });

  server.close(() => {
    logger.info({ event: "http_server_closed" });
  });

  wss.close(() => {
    logger.info({ event: "websocket_server_closed" });
  });

  await redis.quit();
  await db.pool.end();

  logger.info({ event: "shutdown_complete" });
  process.exit(0);
});

export default app;
