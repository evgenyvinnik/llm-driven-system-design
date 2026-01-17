/**
 * Structured JSON logging with pino.
 * Provides consistent log format across all services with request tracing,
 * user context, and operation timing capabilities.
 * @module shared/logger
 */

import pino from 'pino';

/**
 * Log level from environment, defaults to 'info' in production, 'debug' in development.
 */
const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

/**
 * Pretty printing configuration for development.
 * In production, logs are JSON for machine parsing.
 */
const transport = process.env.NODE_ENV !== 'production'
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
 * Base logger instance configured for the Dropbox API service.
 * All logs include timestamp, level, and service name.
 */
export const logger = pino({
  level,
  transport,
  base: {
    service: 'dropbox-api',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific or user-specific context.
 * @param bindings - Additional context to include in all logs from this logger
 * @returns Child logger with bound context
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}

/**
 * Creates a request-scoped logger with trace ID and user context.
 * @param traceId - Unique identifier for request tracing
 * @param userId - Optional user ID for authenticated requests
 * @returns Child logger with request context
 */
export function createRequestLogger(traceId: string, userId?: string): pino.Logger {
  return logger.child({
    traceId,
    ...(userId && { userId }),
  });
}

/**
 * Measures and logs operation duration.
 * Returns a function to call when operation completes.
 * @param operationLogger - Logger to use for timing
 * @param operation - Name of the operation being timed
 * @param metadata - Additional context for the log entry
 * @returns Function to call when operation completes
 */
export function startTimer(
  operationLogger: pino.Logger,
  operation: string,
  metadata?: Record<string, unknown>
): () => void {
  const startTime = process.hrtime.bigint();
  return () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;
    operationLogger.info({ operation, durationMs, ...metadata }, `${operation} completed`);
  };
}

/**
 * Log levels for typed logging
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Standard log context for file operations
 */
export interface FileOperationContext {
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  userId: string;
  operation: 'upload' | 'download' | 'delete' | 'rename' | 'move' | 'version' | 'sync';
}

/**
 * Standard log context for chunk operations
 */
export interface ChunkOperationContext {
  chunkHash: string;
  chunkSize?: number;
  chunkIndex?: number;
  uploadSessionId?: string;
  operation: 'upload' | 'download' | 'check' | 'delete';
  deduplicated?: boolean;
}

/**
 * Logs a file operation with standard context
 */
export function logFileOperation(
  context: FileOperationContext,
  message: string,
  level: LogLevel = 'info'
): void {
  logger[level](context, message);
}

/**
 * Logs a chunk operation with standard context
 */
export function logChunkOperation(
  context: ChunkOperationContext,
  message: string,
  level: LogLevel = 'info'
): void {
  logger[level](context, message);
}

export default logger;
