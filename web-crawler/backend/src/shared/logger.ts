/**
 * @fileoverview Structured JSON logging with pino.
 *
 * Centralized logging configuration for the web crawler. Uses pino for:
 * - Structured JSON output (machine-parseable for log aggregation)
 * - Consistent log levels across all services
 * - Request correlation via request IDs
 * - Performance (pino is one of the fastest Node.js loggers)
 *
 * WHY STRUCTURED LOGGING:
 * In a distributed crawler with multiple workers, logs from different processes
 * interleave. Structured JSON logs enable:
 * 1. Filtering by worker_id, url, domain, or any field
 * 2. Correlation of requests across services via request_id
 * 3. Easy ingestion into log aggregation systems (ELK, Loki, etc.)
 * 4. Metric extraction from log data (error rates, latencies)
 *
 * @module shared/logger
 */

import pino from 'pino';
import { config } from '../config.js';

/**
 * Base logger configuration.
 * Pretty printing in development, JSON in production.
 */
const loggerOptions: pino.LoggerOptions = {
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  // Base fields included in every log entry
  base: {
    service: 'web-crawler',
    env: config.nodeEnv,
  },
  // ISO timestamp for easier parsing
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Use pretty printing in development for readability
const transport =
  config.nodeEnv === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

/**
 * Main application logger.
 *
 * @example
 * ```typescript
 * import { logger } from './shared/logger';
 *
 * // Simple logging
 * logger.info('Server started');
 *
 * // Structured logging with context
 * logger.info({ url, domain, statusCode }, 'Page crawled');
 *
 * // Error logging with stack trace
 * logger.error({ err, url }, 'Crawl failed');
 * ```
 */
export const logger = pino(loggerOptions, transport ? pino.transport(transport) : undefined);

/**
 * Creates a child logger with additional context.
 *
 * Use this to add persistent context like worker_id or request_id
 * that should appear in all subsequent log entries.
 *
 * @param bindings - Additional fields to include in all logs
 * @returns Child logger with the additional context
 *
 * @example
 * ```typescript
 * const workerLogger = createChildLogger({ workerId: 'worker-1' });
 * workerLogger.info({ url }, 'Fetching page');
 * // Logs: { workerId: "worker-1", url: "...", msg: "Fetching page" }
 * ```
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}

/**
 * Logger for Express requests.
 * Can be used with pino-http middleware for request logging.
 */
export const requestLogger = logger.child({ component: 'http' });

/**
 * Logger for crawler workers.
 */
export function createWorkerLogger(workerId: string): pino.Logger {
  return logger.child({ component: 'crawler', workerId });
}

/**
 * Logger for database operations.
 */
export const dbLogger = logger.child({ component: 'database' });

/**
 * Logger for Redis operations.
 */
export const redisLogger = logger.child({ component: 'redis' });

/**
 * Logger for circuit breaker events.
 */
export const circuitBreakerLogger = logger.child({ component: 'circuit-breaker' });
