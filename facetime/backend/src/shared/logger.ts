/**
 * Structured JSON logging with pino.
 *
 * Provides consistent, machine-readable logs for debugging and observability.
 * Includes request context, call event logging, and audit logging capabilities.
 */

import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Audit event structure for security-sensitive operations.
 */
export interface AuditEvent {
  timestamp: string;
  action: string;
  actor: {
    userId: string;
    deviceId?: string;
    ip?: string;
  };
  resource: {
    type: string;
    id: string;
  };
  outcome: 'success' | 'failure';
  details?: Record<string, unknown>;
}

/**
 * Main application logger.
 * Configured for structured JSON output with service metadata.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'facetime-signaling',
    version: process.env.APP_VERSION || 'dev',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Audit logger for security-sensitive operations.
 * Separate from main logger for potential routing to compliance systems.
 */
export const auditLogger = pino({
  level: 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    type: 'audit',
    service: 'facetime-signaling',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with request context.
 * Used to correlate all logs from a single HTTP request.
 *
 * @param requestId - Optional request ID, generates one if not provided
 * @param method - HTTP method
 * @param path - Request path
 * @returns Child logger with request context
 */
export function createRequestLogger(
  requestId?: string,
  method?: string,
  path?: string
): pino.Logger {
  return logger.child({
    requestId: requestId || uuidv4(),
    method,
    path,
  });
}

/**
 * Creates a child logger for WebSocket connections.
 * Includes client and user context for connection tracking.
 *
 * @param clientId - WebSocket client ID
 * @param userId - Optional user ID after registration
 * @param deviceId - Optional device ID after registration
 * @returns Child logger with WebSocket context
 */
export function createWebSocketLogger(
  clientId: string,
  userId?: string,
  deviceId?: string
): pino.Logger {
  return logger.child({
    clientId,
    userId,
    deviceId,
    transport: 'websocket',
  });
}

/**
 * Logs a call-related event with structured metadata.
 * Centralizes call event logging for consistent format.
 *
 * @param callId - Unique call identifier
 * @param event - Event type (initiated, answered, ended, etc.)
 * @param details - Additional event-specific details
 */
export function logCallEvent(
  callId: string,
  event: string,
  details: Record<string, unknown> = {}
): void {
  logger.info(
    {
      callId,
      event,
      ...details,
    },
    `call:${event}`
  );
}

/**
 * Logs an audit event for security-sensitive operations.
 * Used for compliance and forensic analysis.
 *
 * @param event - The audit event to log
 */
export function logAudit(event: AuditEvent): void {
  auditLogger.info(event, `audit:${event.action}`);
}

/**
 * Logs a signaling event (offer/answer/ICE).
 * Tracks WebRTC signaling flow for debugging connection issues.
 *
 * @param callId - Unique call identifier
 * @param type - Signaling message type
 * @param fromUserId - Sender user ID
 * @param toUserId - Recipient user ID (if known)
 */
export function logSignalingEvent(
  callId: string,
  type: string,
  fromUserId: string,
  toUserId?: string
): void {
  logger.debug(
    {
      callId,
      signalingType: type,
      fromUserId,
      toUserId,
    },
    `signaling:${type}`
  );
}
