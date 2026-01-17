/**
 * @fileoverview Structured logging with pino.
 * Provides consistent, structured logging across all services with proper log levels,
 * request context, and production-ready formatting.
 */

import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Logger configuration based on environment.
 * Development uses pretty printing for readability.
 * Production uses JSON format for log aggregation systems.
 */
const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || (config.nodeEnv === 'production' ? 'info' : 'debug'),
  base: {
    service: 'app-store',
    env: config.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(config.nodeEnv === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
};

/**
 * Main logger instance for the application.
 * Use child loggers for adding context to specific operations.
 *
 * @example
 * // Basic logging
 * logger.info({ userId: '123' }, 'User logged in');
 *
 * // Child logger with persistent context
 * const reqLogger = logger.child({ requestId: 'abc-123' });
 * reqLogger.info('Processing request');
 */
export const logger = pino(loggerOptions);

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific or operation-specific context.
 *
 * @param context - Additional fields to include in all log entries
 * @returns Child logger instance with context
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Logging utilities for common operations.
 */
export const logging = {
  /**
   * Logs an HTTP request with relevant details.
   */
  request(method: string, url: string, statusCode: number, duration: number, extra?: Record<string, unknown>): void {
    logger.info({
      type: 'http_request',
      method,
      url,
      statusCode,
      duration,
      ...extra,
    }, `${method} ${url} ${statusCode} ${duration}ms`);
  },

  /**
   * Logs a database query with timing information.
   */
  query(query: string, duration: number, rowCount?: number): void {
    logger.debug({
      type: 'db_query',
      query: query.substring(0, 100),
      duration,
      rowCount,
    }, `Query executed in ${duration}ms`);
  },

  /**
   * Logs external service calls (Redis, Elasticsearch, etc.).
   */
  externalCall(service: string, operation: string, duration: number, success: boolean, error?: Error): void {
    const level = success ? 'debug' : 'error';
    logger[level]({
      type: 'external_call',
      service,
      operation,
      duration,
      success,
      ...(error && { error: error.message }),
    }, `${service}.${operation} ${success ? 'succeeded' : 'failed'} in ${duration}ms`);
  },

  /**
   * Logs a message queue event (publish/consume).
   */
  queue(operation: 'publish' | 'consume', queue: string, eventType: string, success: boolean, error?: Error): void {
    const level = success ? 'debug' : 'error';
    logger[level]({
      type: 'queue_event',
      operation,
      queue,
      eventType,
      success,
      ...(error && { error: error.message }),
    }, `Queue ${operation} ${eventType} to ${queue} ${success ? 'succeeded' : 'failed'}`);
  },

  /**
   * Logs a business event (purchase, review, download).
   */
  businessEvent(event: string, data: Record<string, unknown>): void {
    logger.info({
      type: 'business_event',
      event,
      ...data,
    }, `Business event: ${event}`);
  },

  /**
   * Logs a circuit breaker state change.
   */
  circuitBreaker(name: string, state: string, failureCount?: number): void {
    const level = state === 'open' ? 'warn' : 'info';
    logger[level]({
      type: 'circuit_breaker',
      name,
      state,
      failureCount,
    }, `Circuit breaker ${name} is now ${state}`);
  },
};

export default logger;
