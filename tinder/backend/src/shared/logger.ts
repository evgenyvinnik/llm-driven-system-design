import pino from 'pino';
import { serverConfig } from './config.js';

/**
 * Structured JSON logger using Pino.
 * Provides high-performance logging with context support.
 * In development mode, uses pino-pretty for human-readable output.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    env: serverConfig.nodeEnv,
    version: serverConfig.version,
  },
  transport:
    serverConfig.nodeEnv === 'development'
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
 * Useful for adding request-specific or service-specific context.
 * @param bindings - Additional context to include in all log messages
 * @returns Child logger with merged context
 */
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/**
 * Log levels for consistent usage across the application.
 */
export const LogLevel = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;

/**
 * Standard log context fields for request logging.
 */
export interface RequestLogContext {
  requestId?: string;
  userId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
  ip?: string;
  userAgent?: string;
}

/**
 * Creates a structured log entry for HTTP requests.
 * @param context - Request-specific log context
 * @returns Formatted log object
 */
export function formatRequestLog(context: RequestLogContext) {
  return {
    request: {
      id: context.requestId,
      method: context.method,
      path: context.path,
      ip: context.ip,
      userAgent: context.userAgent,
    },
    response: {
      statusCode: context.statusCode,
      duration: context.duration,
    },
    user: context.userId ? { id: context.userId } : undefined,
  };
}

/**
 * Log context for swipe actions.
 */
export interface SwipeLogContext {
  swiperId: string;
  swipedId: string;
  direction: 'like' | 'pass';
  isMatch?: boolean;
  idempotent?: boolean;
}

/**
 * Log context for match events.
 */
export interface MatchLogContext {
  matchId: string;
  user1Id: string;
  user2Id: string;
}

/**
 * Log context for message events.
 */
export interface MessageLogContext {
  matchId: string;
  senderId: string;
  messageId?: string;
}
