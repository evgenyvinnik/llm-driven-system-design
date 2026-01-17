/**
 * Structured JSON logging with pino.
 *
 * Provides consistent, performant logging across all services with:
 * - Structured JSON output for production
 * - Pretty printing for development
 * - Request correlation via trace IDs
 * - Log levels: error, warn, info, debug
 */
import pino from 'pino';

/**
 * Determine if we're in development mode for pretty printing.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Get the server instance identifier from PORT or hostname.
 */
const serverInstance = process.env.PORT
  ? `server-${process.env.PORT}`
  : 'server-main';

/**
 * Base logger configuration with structured output.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  base: {
    service: 'rplace-api',
    instance: serverInstance,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: isDevelopment
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
 * Creates a child logger with additional context.
 * Useful for adding request-specific fields like traceId.
 *
 * @param context - Additional fields to include in all log messages.
 * @returns A child logger instance.
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Generates a unique trace ID for request correlation.
 * Uses a combination of timestamp and random suffix for uniqueness.
 *
 * @returns A unique trace ID string.
 */
export function generateTraceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}

/**
 * Logs a pixel placement event with standard fields.
 *
 * @param params - Pixel placement details.
 */
export function logPixelPlacement(params: {
  traceId?: string;
  userId: string;
  x: number;
  y: number;
  color: number;
  latencyMs: number;
}) {
  logger.info(
    {
      event: 'pixel_placed',
      traceId: params.traceId,
      userId: params.userId,
      x: params.x,
      y: params.y,
      color: params.color,
      latencyMs: params.latencyMs,
    },
    `Pixel placed at (${params.x},${params.y}) color=${params.color}`
  );
}

/**
 * Logs a rate limit hit event.
 *
 * @param params - Rate limit details.
 */
export function logRateLimitHit(params: {
  traceId?: string;
  userId: string;
  remainingSeconds: number;
}) {
  logger.warn(
    {
      event: 'rate_limit_hit',
      traceId: params.traceId,
      userId: params.userId,
      remainingSeconds: params.remainingSeconds,
    },
    `Rate limit hit for user ${params.userId}, ${params.remainingSeconds}s remaining`
  );
}

/**
 * Logs a WebSocket connection event.
 *
 * @param params - Connection details.
 */
export function logWebSocketConnection(params: {
  event: 'connected' | 'disconnected' | 'error';
  userId?: string;
  username?: string;
  totalConnections: number;
  error?: string;
}) {
  const logFn = params.event === 'error' ? logger.error : logger.info;
  logFn.call(
    logger,
    {
      event: `websocket_${params.event}`,
      userId: params.userId,
      username: params.username,
      totalConnections: params.totalConnections,
      error: params.error,
    },
    `WebSocket ${params.event}: ${params.username || 'anonymous'} (${params.totalConnections} total)`
  );
}

/**
 * Logs a circuit breaker state change.
 *
 * @param params - Circuit breaker details.
 */
export function logCircuitBreakerEvent(params: {
  name: string;
  event: 'open' | 'close' | 'halfOpen' | 'fallback';
  error?: string;
}) {
  const logFn = params.event === 'fallback' ? logger.warn : logger.info;
  logFn.call(
    logger,
    {
      event: `circuit_breaker_${params.event}`,
      circuitName: params.name,
      error: params.error,
    },
    `Circuit breaker ${params.name}: ${params.event}`
  );
}

export default logger;
