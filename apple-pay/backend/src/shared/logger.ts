/**
 * Structured Logging Module with Pino
 *
 * Provides structured JSON logging for observability and debugging.
 * Features:
 * - Request correlation via request IDs
 * - Standard log levels (debug, info, warn, error)
 * - Child loggers for service-specific context
 * - Redaction of sensitive fields (PAN, CVV, tokens)
 *
 * WHY: Structured logging enables log aggregation, searching, and alerting
 * in production environments. JSON format integrates with ELK stack, Datadog,
 * and other observability tools.
 */
import pino from 'pino';
import { Request, Response, NextFunction } from 'express';

/**
 * Redaction paths for sensitive payment data.
 * These fields will be replaced with [REDACTED] in logs.
 */
const redactPaths = [
  'pan',
  'cvv',
  'card_number',
  'token',
  'token_dpan',
  'cryptogram',
  'password',
  'password_hash',
  'req.body.pan',
  'req.body.cvv',
  'req.body.password',
  'req.headers.authorization',
  'req.headers["x-session-id"]',
];

/**
 * Base logger instance with redaction and environment-aware formatting.
 * In development, uses pretty printing for readability.
 * In production, uses JSON for machine parsing.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname,
      service: 'apple-pay-backend',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

/**
 * Creates a child logger with additional context bound to all log entries.
 * Use for service-specific logging (e.g., PaymentService, TokenService).
 *
 * @param context - Object with fields to include in every log entry
 * @returns Child logger instance
 *
 * @example
 * const serviceLogger = createChildLogger({ service: 'PaymentService' });
 * serviceLogger.info({ transactionId }, 'Processing payment');
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Express middleware for request logging with correlation IDs.
 * Adds a unique requestId to each request and logs request/response details.
 *
 * Attaches:
 * - req.log: Child logger with request context
 * - req.requestId: Unique request identifier
 *
 * @example
 * app.use(requestLogger);
 * // In route handler:
 * req.log.info({ userId: req.userId }, 'Processing user request');
 */
export function requestLogger(
  req: Request & { log?: pino.Logger; requestId?: string },
  res: Response,
  next: NextFunction
) {
  // Use existing request ID or generate new one
  const requestId =
    (req.headers['x-request-id'] as string) ||
    `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // Create child logger with request context
  req.requestId = requestId;
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
  });

  // Log request start
  req.log.info({ query: req.query }, 'Request started');

  // Track response time and log completion
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log?.[level](
      {
        statusCode: res.statusCode,
        durationMs: duration.toFixed(2),
      },
      'Request completed'
    );
  });

  // Add request ID to response headers for tracing
  res.setHeader('X-Request-Id', requestId);

  next();
}

/**
 * Log levels for different severity types.
 * Use appropriate level for log searchability and alerting.
 */
export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

export default logger;
