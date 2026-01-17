/**
 * @fileoverview Structured JSON logging with pino.
 * Provides consistent log formatting across all services with
 * request correlation, error context, and performance tracing.
 */

import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Log level based on environment.
 * Development: debug for verbose output
 * Production: info for performance
 * Test: silent to reduce noise
 */
const logLevel = (() => {
  switch (config.env) {
    case 'development':
      return 'debug';
    case 'test':
      return 'silent';
    case 'production':
    default:
      return 'info';
  }
})();

/**
 * Main application logger instance.
 * Uses JSON format in production for structured log aggregation.
 * Uses pretty printing in development for readability.
 */
export const logger = pino({
  level: logLevel,
  base: {
    service: 'fb-post-search',
    env: config.env,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Use pino-pretty in development
  transport:
    config.env === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname,service,env',
          },
        }
      : undefined,
});

/**
 * Creates a child logger with request context.
 * Useful for tracing requests across service calls.
 * @param requestId - Unique request identifier
 * @param userId - Authenticated user ID (optional)
 * @returns Child logger instance with bound context
 */
export function createRequestLogger(
  requestId: string,
  userId?: string
): pino.Logger {
  return logger.child({
    requestId,
    ...(userId && { userId }),
  });
}

/**
 * Log levels with semantic meaning for the application.
 */
export const LogLevel = {
  /** System is unusable */
  FATAL: 'fatal',
  /** Action must be taken immediately */
  ERROR: 'error',
  /** Warning conditions */
  WARN: 'warn',
  /** Informational messages */
  INFO: 'info',
  /** Debug-level messages */
  DEBUG: 'debug',
  /** Trace-level messages (very verbose) */
  TRACE: 'trace',
} as const;

/**
 * Structured log context for search operations.
 */
export interface SearchLogContext {
  query: string;
  userId?: string;
  filters?: Record<string, unknown>;
  resultsCount: number;
  durationMs: number;
  cacheHit?: boolean;
}

/**
 * Structured log context for indexing operations.
 */
export interface IndexingLogContext {
  postId: string;
  operation: 'create' | 'update' | 'delete';
  durationMs: number;
  lagMs?: number;
}

/**
 * Structured log context for errors.
 */
export interface ErrorLogContext {
  error: Error;
  requestId?: string;
  userId?: string;
  operation?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Logs a search operation with structured context.
 * @param ctx - Search operation context
 */
export function logSearch(ctx: SearchLogContext): void {
  logger.info(
    {
      event: 'search',
      query: ctx.query,
      userId: ctx.userId,
      filters: ctx.filters,
      resultsCount: ctx.resultsCount,
      durationMs: ctx.durationMs,
      cacheHit: ctx.cacheHit,
    },
    `Search completed: "${ctx.query}" returned ${ctx.resultsCount} results in ${ctx.durationMs}ms`
  );
}

/**
 * Logs an indexing operation with structured context.
 * @param ctx - Indexing operation context
 */
export function logIndexing(ctx: IndexingLogContext): void {
  logger.info(
    {
      event: 'indexing',
      postId: ctx.postId,
      operation: ctx.operation,
      durationMs: ctx.durationMs,
      lagMs: ctx.lagMs,
    },
    `Indexed post ${ctx.postId} (${ctx.operation}) in ${ctx.durationMs}ms`
  );
}

/**
 * Logs an error with structured context.
 * @param ctx - Error context
 */
export function logError(ctx: ErrorLogContext): void {
  logger.error(
    {
      event: 'error',
      error: {
        name: ctx.error.name,
        message: ctx.error.message,
        stack: ctx.error.stack,
      },
      requestId: ctx.requestId,
      userId: ctx.userId,
      operation: ctx.operation,
      metadata: ctx.metadata,
    },
    `Error in ${ctx.operation || 'unknown operation'}: ${ctx.error.message}`
  );
}

/**
 * Logs a circuit breaker state change.
 * @param service - Service name (e.g., 'elasticsearch')
 * @param state - New state (open, closed, half_open)
 * @param reason - Reason for state change
 */
export function logCircuitBreakerStateChange(
  service: string,
  state: 'open' | 'closed' | 'half_open',
  reason?: string
): void {
  const level = state === 'open' ? 'warn' : 'info';
  logger[level](
    {
      event: 'circuit_breaker',
      service,
      state,
      reason,
    },
    `Circuit breaker for ${service} is now ${state}${reason ? `: ${reason}` : ''}`
  );
}

/**
 * Logs a health check result.
 * @param services - Health status of each service
 * @param overall - Overall health status
 */
export function logHealthCheck(
  services: Record<string, boolean>,
  overall: 'ok' | 'degraded'
): void {
  const level = overall === 'ok' ? 'debug' : 'warn';
  logger[level](
    {
      event: 'health_check',
      services,
      overall,
    },
    `Health check: ${overall}`
  );
}
