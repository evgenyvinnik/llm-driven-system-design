/**
 * Structured JSON logging with Pino.
 *
 * WHY: Structured logging is essential for production typeahead systems:
 * - Machine-parseable logs for aggregation (ELK, Splunk, Datadog)
 * - Consistent log format across all services
 * - Request tracing with correlation IDs
 * - Performance metrics embedded in logs
 */
import pino from 'pino';
import pinoHttp from 'pino-http';
import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Request, Response, NextFunction } from 'express';

// Create base logger with structured output
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  base: {
    service: 'typeahead',
    version: process.env.APP_VERSION || '1.0.0',
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Use pino-http with explicit any to avoid type conflicts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoHttpMiddleware = (pinoHttp as any)({
  logger,
  genReqId: (req: IncomingMessage) =>
    (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customProps: (req: any) => ({
    requestId: req.id,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customLogLevel: (_req: any, res: ServerResponse, err?: Error) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customSuccessMessage: (req: any) => {
    return `${req.method} ${req.url} completed`;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customErrorMessage: (req: any, _res: ServerResponse, err?: Error) => {
    return `${req.method} ${req.url} failed: ${err?.message || 'unknown error'}`;
  },
  serializers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req: (req: any) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query?.q ? req.query.q.substring(0, 50) : undefined,
      userId: req.headers?.['x-user-id'] || 'anonymous',
    }),
    res: (res: ServerResponse) => ({
      statusCode: res.statusCode,
    }),
  },
});

/**
 * HTTP request logging middleware.
 * Logs request/response with timing and correlation ID.
 */
export const httpLogger = (req: Request, res: Response, next: NextFunction): void => {
  pinoHttpMiddleware(req, res, next);
};

/**
 * Audit logger for sensitive operations.
 * Used for tracking admin actions, filter changes, etc.
 */
export const auditLogger = {
  /**
   * Log filter list changes
   */
  logFilterChange(
    action: 'add' | 'remove',
    phrase: string | undefined,
    reason: string,
    adminUserId: string = 'system'
  ): void {
    logger.info({
      type: 'audit',
      event: 'filter_change',
      action,
      phrase: phrase?.substring(0, 50),
      reason,
      adminUserId,
    });
  },

  /**
   * Log trie rebuild operations
   */
  logTrieRebuild(triggeredBy: string, phraseCount: number, durationMs: number): void {
    logger.info({
      type: 'audit',
      event: 'trie_rebuild',
      triggeredBy,
      phraseCount,
      durationMs,
    });
  },

  /**
   * Log cache invalidation
   */
  logCacheInvalidation(
    pattern: string | undefined,
    reason: string,
    adminUserId: string = 'system'
  ): void {
    logger.info({
      type: 'audit',
      event: 'cache_invalidation',
      pattern: pattern?.substring(0, 50),
      reason,
      adminUserId,
    });
  },

  /**
   * Log rate limit violations
   */
  logRateLimitViolation(
    clientId: string,
    endpoint: string,
    currentRate: number,
    limit: number
  ): void {
    logger.warn({
      type: 'audit',
      event: 'rate_limit_exceeded',
      clientId,
      endpoint,
      currentRate,
      limit,
    });
  },

  /**
   * Log idempotent operation skip
   */
  logIdempotencySkip(idempotencyKey: string, operation: string): void {
    logger.info({
      type: 'audit',
      event: 'idempotency_skip',
      idempotencyKey,
      operation,
    });
  },

  /**
   * Log circuit breaker state change
   */
  logCircuitStateChange(
    circuitName: string,
    oldState: string,
    newState: string,
    reason: string
  ): void {
    logger.warn({
      type: 'audit',
      event: 'circuit_state_change',
      circuitName,
      oldState,
      newState,
      reason,
    });
  },
};

export default logger;
