/**
 * Structured Logging Module (Pino)
 *
 * Provides structured JSON logging for the Baby Discord application.
 * Pino is chosen over Winston for its superior performance and structured
 * output format that's ideal for log aggregation systems.
 *
 * Features:
 * - Structured JSON output in production
 * - Pretty-printed output in development
 * - Instance ID included in all logs for multi-instance deployments
 * - Configurable log levels via environment
 * - Child loggers for context-specific logging
 */

import pino from 'pino';
import { server } from '../shared/config.js';

// ============================================================================
// Logger Configuration
// ============================================================================

/**
 * Determine if pretty-printing should be enabled.
 * Use pretty printing in development for human readability.
 */
const isPretty = server.nodeEnv === 'development' || process.stdout.isTTY;

/**
 * Transport configuration for development (pretty printing).
 * In production, logs are written as JSON for machine parsing.
 */
const transport = isPretty
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageFormat: '[instance-{instance}] {msg}',
      },
    }
  : undefined;

/**
 * Base logger configuration.
 */
const baseConfig: pino.LoggerOptions = {
  level: server.logLevel,
  base: {
    instance: server.instanceId,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
};

// ============================================================================
// Logger Instance
// ============================================================================

/**
 * Main application logger.
 *
 * All logs include:
 * - Timestamp in ISO format
 * - Instance ID for multi-instance correlation
 * - Structured JSON for log aggregation
 *
 * @example
 * logger.info('User connected', { userId: 123, transport: 'tcp' });
 * logger.error({ err: error }, 'Database query failed');
 * logger.debug({ roomName: 'general', memberCount: 5 }, 'Room state updated');
 */
export const logger = transport
  ? pino(baseConfig, pino.transport(transport))
  : pino(baseConfig);

// ============================================================================
// Child Loggers for Components
// ============================================================================

/**
 * Create a child logger with additional context.
 * Child loggers inherit the parent's configuration but add
 * component-specific fields to all log entries.
 *
 * @param component - Component name (e.g., 'http', 'tcp', 'pubsub')
 * @param additionalContext - Additional fields to include in all logs
 * @returns Child logger with component context
 *
 * @example
 * const httpLogger = createChildLogger('http', { port: 3001 });
 * httpLogger.info('Server started'); // Includes component: 'http', port: 3001
 */
export function createChildLogger(
  component: string,
  additionalContext: Record<string, unknown> = {}
): pino.Logger {
  return logger.child({ component, ...additionalContext });
}

/**
 * Pre-configured child loggers for common components.
 */
export const httpLogger = createChildLogger('http');
export const tcpLogger = createChildLogger('tcp');
export const dbLogger = createChildLogger('database');
export const pubsubLogger = createChildLogger('pubsub');
export const coreLogger = createChildLogger('core');

// ============================================================================
// Request Logging Helper
// ============================================================================

/**
 * Generate a request ID for correlation.
 * Uses a simple counter + timestamp for uniqueness.
 */
let requestCounter = 0;

export function generateRequestId(): string {
  requestCounter = (requestCounter + 1) % 1000000;
  return `${Date.now()}-${requestCounter.toString().padStart(6, '0')}`;
}

/**
 * Create a request-scoped logger for HTTP requests.
 *
 * @param method - HTTP method
 * @param path - Request path
 * @param requestId - Optional request ID (generated if not provided)
 * @returns Request-scoped logger
 */
export function createRequestLogger(
  method: string,
  path: string,
  requestId?: string
): pino.Logger {
  return httpLogger.child({
    requestId: requestId || generateRequestId(),
    method,
    path,
  });
}

// ============================================================================
// Specialized Logging Functions
// ============================================================================

/**
 * Log a message with performance timing.
 * Calculates duration from start time to now.
 *
 * @param startTime - High-resolution start time from process.hrtime.bigint()
 * @param message - Log message
 * @param context - Additional context
 */
export function logWithTiming(
  startTime: bigint,
  message: string,
  context: Record<string, unknown> = {}
): void {
  const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
  logger.info({ ...context, durationMs }, message);
}

/**
 * Log an error with full stack trace.
 * Pino serializes Error objects properly when passed as `err` property.
 *
 * @param error - Error object
 * @param message - Error description
 * @param context - Additional context
 */
export function logError(
  error: Error,
  message: string,
  context: Record<string, unknown> = {}
): void {
  logger.error({ err: error, ...context }, message);
}

/**
 * Log a warning when an alert threshold is exceeded.
 *
 * @param metric - Name of the metric
 * @param value - Current value
 * @param threshold - Exceeded threshold
 * @param severity - 'warning' or 'critical'
 */
export function logThresholdExceeded(
  metric: string,
  value: number,
  threshold: number,
  severity: 'warning' | 'critical'
): void {
  const logFn = severity === 'critical' ? logger.error.bind(logger) : logger.warn.bind(logger);
  logFn(
    { metric, value, threshold, severity },
    `${metric} exceeded ${severity} threshold: ${value} > ${threshold}`
  );
}

// ============================================================================
// Shutdown Logging
// ============================================================================

/**
 * Flush logs before shutdown.
 * Pino is asynchronous, so we need to ensure logs are written before exit.
 *
 * @returns Promise that resolves when logs are flushed
 */
export function flushLogs(): Promise<void> {
  return new Promise<void>((resolve) => {
    logger.flush();
    // Give a small delay for async flushing
    setTimeout(resolve, 100);
  });
}

export default logger;
