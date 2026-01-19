import pino, { Logger } from 'pino';
import type { Request, Response } from 'express';
import type { Session, SessionData } from 'express-session';
import config from '../config/index.js';

/**
 * Extended Express Request type with custom properties
 */
export interface ExtendedRequest extends Omit<Request, 'session'> {
  traceId?: string;
  session: Session & Partial<SessionData> & {
    userId?: string;
    username?: string;
    role?: string;
    isVerified?: boolean;
  };
}

/**
 * Structured JSON logger using pino
 *
 * Provides consistent logging format across all services with:
 * - Request ID tracking for distributed tracing
 * - User context when available
 * - Performance timing
 * - Error stack traces
 */
const logger: Logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  base: {
    service: 'instagram-api',
    env: config.nodeEnv,
    port: config.port,
  },
  // In production, use default JSON output
  // In development, use pretty printing
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino/file',
          options: { destination: 1 }, // stdout
        }
      : undefined,
});

/**
 * Create a child logger with request context
 */
export const createRequestLogger = (req: ExtendedRequest): Logger => {
  return logger.child({
    requestId: req.traceId,
    method: req.method,
    path: req.path,
    userId: req.session?.userId,
    username: req.session?.username,
  });
};

/**
 * Log request completion with timing
 */
export const logRequest = (req: ExtendedRequest, res: Response, duration: number): void => {
  const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

  logger[level](
    {
      requestId: req.traceId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
      userId: req.session?.userId,
      contentLength: res.get('content-length'),
      userAgent: req.get('user-agent'),
    },
    `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`
  );
};

/**
 * Log an error with full context
 */
export const logError = (error: Error, context: Record<string, unknown> = {}): void => {
  logger.error(
    {
      error: error.name || 'Error',
      message: error.message,
      stack: error.stack,
      ...context,
    },
    error.message
  );
};

/**
 * Log a database query with timing
 */
export const logQuery = (queryName: string, duration: number, context: Record<string, unknown> = {}): void => {
  const level = duration > 1000 ? 'warn' : 'debug';
  logger[level](
    {
      type: 'db_query',
      query: queryName,
      durationMs: duration,
      ...context,
    },
    `DB: ${queryName} (${duration}ms)`
  );
};

/**
 * Log a cache operation
 */
export const logCache = (operation: string, key: string, hit: boolean | null = null): void => {
  logger.debug(
    {
      type: 'cache',
      operation,
      key: key.substring(0, 50), // Truncate long keys
      hit,
    },
    `Cache ${operation}: ${key.substring(0, 50)}${hit !== null ? (hit ? ' HIT' : ' MISS') : ''}`
  );
};

/**
 * Log a metrics event (for business metrics)
 */
export const logMetric = (event: string, data: Record<string, unknown> = {}): void => {
  logger.info(
    {
      type: 'metric',
      event,
      ...data,
    },
    `Metric: ${event}`
  );
};

export { logger };
export default logger;
