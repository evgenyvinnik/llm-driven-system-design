/**
 * Structured Logging Module.
 *
 * Provides centralized logging with pino for the APNs backend.
 * Features:
 * - JSON-formatted logs for easy parsing and aggregation
 * - Log levels configurable via LOG_LEVEL environment variable
 * - Request logging middleware for HTTP traffic
 * - Specialized loggers for different concerns (audit, delivery)
 *
 * WHY: Structured logging enables centralized log aggregation,
 * efficient debugging, and integration with observability platforms
 * like ELK stack or Datadog. JSON format allows for filtering and
 * querying logs by specific fields.
 *
 * @module shared/logger
 */

import pino from "pino";
import pinoHttp from "pino-http";

/**
 * Log level from environment, defaults to "info" in production.
 * Available levels: trace, debug, info, warn, error, fatal
 */
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === "development" ? "debug" : "info");

/**
 * Main application logger instance.
 * Use this for general application logging.
 */
export const logger = pino({
  level: LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Add timestamp in ISO format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Base fields included in every log
  base: {
    service: "apns-backend",
    server_id: `server-${process.env.PORT || 3000}`,
  },
});

/**
 * HTTP request logging middleware.
 * Logs method, path, status code, and duration for each request.
 * Integrates with Express for automatic request tracking.
 */
export const httpLogger = pinoHttp({
  logger,
  // Customize logged request data
  customLogLevel: function (req, res, err) {
    if (res.statusCode >= 500 || err) {
      return "error";
    } else if (res.statusCode >= 400) {
      return "warn";
    }
    return "info";
  },
  // Custom attributes to log
  customSuccessMessage: function (req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: function (req, res, err) {
    return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
  },
  // Reduce noise in logs by redacting sensitive headers
  redact: ["req.headers.authorization", "req.headers.cookie"],
  // Add request ID for correlation
  genReqId: function (req) {
    return (req.headers["x-request-id"] as string) || crypto.randomUUID();
  },
});

/**
 * Audit logger for security-relevant events.
 * Logs token lifecycle, authentication, and admin operations.
 * These logs should be preserved for compliance and forensics.
 *
 * WHY: Audit logs provide a security trail for compliance requirements
 * and incident investigation. Separating them from operational logs
 * makes it easier to apply different retention policies.
 */
export const auditLogger = pino({
  level: "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    type: "audit",
    service: "apns-backend",
  },
});

/**
 * Creates a child logger with additional context.
 * Use for request-scoped or operation-scoped logging.
 *
 * @param bindings - Additional fields to include in all logs from this logger
 * @returns Child logger instance
 */
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/**
 * Log a notification delivery event.
 * Standardized format for delivery tracking and debugging.
 *
 * @param notificationId - UUID of the notification
 * @param deviceId - Target device UUID
 * @param status - Delivery status (delivered, queued, failed, expired)
 * @param metadata - Additional context (priority, latency, error)
 */
export function logDelivery(
  notificationId: string,
  deviceId: string,
  status: string,
  metadata: Record<string, unknown> = {}
): void {
  logger.info({
    event: "notification_delivery",
    notification_id: notificationId,
    device_id: deviceId,
    status,
    ...metadata,
  });
}

/**
 * Log a token lifecycle event for audit purposes.
 *
 * @param event - Event type (registered, invalidated, lookup_failed)
 * @param tokenHashPrefix - First 8 characters of token hash (for identification)
 * @param context - Additional context (app_bundle_id, reason, actor)
 */
export function auditToken(
  event: "registered" | "invalidated" | "lookup_failed" | "lookup_success",
  tokenHashPrefix: string,
  context: {
    appBundleId?: string;
    reason?: string;
    actor?: "provider" | "system" | "admin";
    isNew?: boolean;
  }
): void {
  auditLogger.info({
    event: "token_audit",
    action: event,
    token_hash_prefix: tokenHashPrefix,
    ...context,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log an authentication event for audit purposes.
 *
 * @param event - Event type (auth_success, auth_failure, session_created)
 * @param context - Request context (ip, user_agent, user_id)
 */
export function auditAuth(
  event: "auth_success" | "auth_failure" | "session_created" | "session_destroyed",
  context: {
    userId?: string;
    username?: string;
    ip?: string;
    userAgent?: string;
    reason?: string;
  }
): void {
  auditLogger.info({
    event: "auth_audit",
    action: event,
    ...context,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log an admin operation for audit purposes.
 *
 * @param event - Operation type (bulk_invalidate, rate_limit_change, etc.)
 * @param adminId - Admin user ID performing the action
 * @param details - Operation-specific details
 */
export function auditAdmin(
  event: string,
  adminId: string,
  details: Record<string, unknown>
): void {
  auditLogger.info({
    event: "admin_audit",
    action: event,
    admin_id: adminId,
    details,
    timestamp: new Date().toISOString(),
  });
}

export default logger;
