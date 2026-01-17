/**
 * @fileoverview Structured JSON logging using Pino.
 * Provides consistent log format across all services with
 * request context, performance metrics, and operational metadata.
 */

import pino from 'pino';
import { ENV_CONFIG } from './config.js';

/**
 * Base logger configuration with JSON formatting.
 * In production, logs are sent to stdout for container orchestrators.
 * In development, uses pretty printing for readability.
 */
const baseConfig: pino.LoggerOptions = {
  name: ENV_CONFIG.SERVICE_NAME,
  level: process.env.LOG_LEVEL || (ENV_CONFIG.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: {
    service: ENV_CONFIG.SERVICE_NAME,
    version: ENV_CONFIG.SERVICE_VERSION,
    env: ENV_CONFIG.NODE_ENV,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Development-friendly transport with pretty printing.
 * Only enabled in non-production environments.
 */
const devTransport = ENV_CONFIG.NODE_ENV !== 'production' ? {
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
} : {};

/**
 * Main application logger instance.
 * Use this for general application logging.
 */
export const logger = pino({
  ...baseConfig,
  ...devTransport,
});

/**
 * Creates a child logger with additional context.
 * Use for request-scoped logging or service-specific logs.
 *
 * @param context - Additional fields to include in all log entries
 * @returns Child logger with merged context
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Creates a request-scoped logger with request ID and metadata.
 * Call at the start of each request handler.
 *
 * @param requestId - Unique request identifier
 * @param method - HTTP method
 * @param path - Request path
 * @returns Logger with request context
 */
export function createRequestLogger(
  requestId: string,
  method: string,
  path: string
): pino.Logger {
  return logger.child({
    requestId,
    method,
    path,
  });
}

/**
 * Log levels and their intended usage:
 *
 * - fatal: Application is about to crash
 * - error: Operation failed, requires investigation
 * - warn: Unexpected state but operation continues
 * - info: Significant events (requests, processing results)
 * - debug: Detailed debugging information
 * - trace: Very detailed tracing (rarely used in production)
 */

/**
 * Structured log helpers for common operations
 */
export const logHelpers = {
  /**
   * Log a click ingestion event
   */
  clickIngested: (
    log: pino.Logger,
    clickId: string,
    adId: string,
    campaignId: string,
    durationMs: number,
    metadata?: Record<string, unknown>
  ) => {
    log.info({
      event: 'click_ingested',
      clickId,
      adId,
      campaignId,
      durationMs,
      ...metadata,
    }, 'Click ingested successfully');
  },

  /**
   * Log a duplicate click detection
   */
  duplicateDetected: (
    log: pino.Logger,
    clickId: string,
  ) => {
    log.debug({
      event: 'duplicate_detected',
      clickId,
    }, 'Duplicate click detected and skipped');
  },

  /**
   * Log a fraud detection result
   */
  fraudDetected: (
    log: pino.Logger,
    clickId: string,
    reason: string,
    confidence: number
  ) => {
    log.warn({
      event: 'fraud_detected',
      clickId,
      reason,
      confidence,
    }, 'Fraudulent click detected');
  },

  /**
   * Log aggregation update
   */
  aggregationUpdated: (
    log: pino.Logger,
    adId: string,
    timeBucket: string,
    granularity: string,
    durationMs: number
  ) => {
    log.debug({
      event: 'aggregation_updated',
      adId,
      timeBucket,
      granularity,
      durationMs,
    }, 'Aggregation updated');
  },

  /**
   * Log database query execution
   */
  queryExecuted: (
    log: pino.Logger,
    query: string,
    durationMs: number,
    rowCount: number | null
  ) => {
    log.debug({
      event: 'query_executed',
      query: query.substring(0, 100),
      durationMs,
      rowCount,
    }, 'Database query executed');
  },

  /**
   * Log Redis operation
   */
  redisOperation: (
    log: pino.Logger,
    operation: string,
    key: string,
    durationMs: number,
    success: boolean
  ) => {
    log.trace({
      event: 'redis_operation',
      operation,
      key,
      durationMs,
      success,
    }, `Redis ${operation} completed`);
  },

  /**
   * Log HTTP request completion
   */
  httpRequest: (
    log: pino.Logger,
    method: string,
    path: string,
    statusCode: number,
    durationMs: number
  ) => {
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    log[level]({
      event: 'http_request',
      method,
      path,
      statusCode,
      durationMs,
    }, `${method} ${path} ${statusCode} ${durationMs}ms`);
  },

  /**
   * Log service health check
   */
  healthCheck: (
    log: pino.Logger,
    healthy: boolean,
    services: Record<string, boolean>
  ) => {
    const level = healthy ? 'debug' : 'error';
    log[level]({
      event: 'health_check',
      healthy,
      services,
    }, `Health check: ${healthy ? 'healthy' : 'unhealthy'}`);
  },

  /**
   * Log data retention cleanup
   */
  retentionCleanup: (
    log: pino.Logger,
    table: string,
    rowsDeleted: number,
    durationMs: number
  ) => {
    log.info({
      event: 'retention_cleanup',
      table,
      rowsDeleted,
      durationMs,
    }, `Cleaned up ${rowsDeleted} rows from ${table}`);
  },
};

export default logger;
