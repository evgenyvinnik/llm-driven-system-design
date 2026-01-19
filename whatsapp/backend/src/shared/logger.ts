/**
 * Structured JSON logging module using pino.
 *
 * Provides consistent, structured logging across the application with:
 * - JSON output for easy parsing and aggregation
 * - Request correlation via trace IDs
 * - Automatic request/response logging middleware
 * - Context-aware child loggers for services
 *
 * WHY structured logging matters:
 * - Enables efficient log aggregation and search in production
 * - Supports distributed tracing across microservices
 * - Provides consistent format for monitoring tools (ELK, Datadog, etc.)
 * - Separates concerns: log generation vs. log processing
 */

import pino from 'pino';
import pinoHttpModule from 'pino-http';
import { config } from '../config.js';
import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

// Handle both ESM and CJS module exports
const pinoHttp = (pinoHttpModule as any).default || pinoHttpModule;

/**
 * Base logger instance configured for the application.
 * All other loggers should be created as children of this logger.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'whatsapp-api',
    server_id: config.serverId,
  },
  // Pretty print in development for readability
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

/**
 * HTTP request logging middleware.
 * Automatically logs all incoming requests with timing and status.
 */
export const httpLogger = pinoHttp({
  logger,
  // Generate unique request IDs for tracing
  genReqId: (req: IncomingMessage) => {
    const existingId = req.headers['x-trace-id'];
    if (existingId && typeof existingId === 'string') {
      return existingId;
    }
    return crypto.randomUUID();
  },
  // Customize what gets logged
  customProps: (req: IncomingMessage) => ({
    user_id: (req as any).session?.userId,
  }),
  // Don't log health checks at info level (too noisy)
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === '/health' || req.url === '/metrics',
  },
  // Redact sensitive headers
  redact: ['req.headers.cookie', 'req.headers.authorization'],
});

/**
 * Creates a child logger for a specific service or module.
 * Inherits base configuration and adds service-specific context.
 *
 * @param serviceName - Name of the service/module for log context
 * @returns A child logger with service context
 */
export function createServiceLogger(serviceName: string) {
  return logger.child({ module: serviceName });
}

/**
 * Log message event types for structured logging.
 * Ensures consistent event naming across the application.
 */
export const LogEvents = {
  // Message events
  MESSAGE_SENT: 'message_sent',
  MESSAGE_DELIVERED: 'message_delivered',
  MESSAGE_READ: 'message_read',
  MESSAGE_FAILED: 'message_failed',

  // Connection events
  WS_CONNECTED: 'ws_connected',
  WS_DISCONNECTED: 'ws_disconnected',
  WS_ERROR: 'ws_error',

  // Auth events
  AUTH_LOGIN: 'auth_login',
  AUTH_LOGOUT: 'auth_logout',
  AUTH_FAILED: 'auth_failed',

  // System events
  RATE_LIMITED: 'rate_limited',
  CIRCUIT_OPEN: 'circuit_open',
  CIRCUIT_CLOSE: 'circuit_close',
  RETRY_ATTEMPT: 'retry_attempt',
  DELIVERY_RETRY: 'delivery_retry',
} as const;

/**
 * Logs a structured message event with consistent format.
 *
 * @param event - The event type from LogEvents
 * @param data - Additional context data to include
 */
export function logEvent(
  event: (typeof LogEvents)[keyof typeof LogEvents],
  data: Record<string, unknown>
) {
  logger.info({ event, ...data });
}
