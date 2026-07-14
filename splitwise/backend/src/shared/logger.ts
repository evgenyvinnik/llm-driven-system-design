/**
 * Structured JSON logging with pino
 *
 * WHY: Structured logging is essential for:
 * - Centralized log aggregation and search (ELK, Splunk, CloudWatch)
 * - Correlation across distributed services via request IDs
 * - Filtering and alerting on specific fields (e.g., error counts, slow queries)
 * - An audit trail for financial-adjacent operations (expenses, settlements)
 */

import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  } : undefined,
  base: {
    service: 'splitwise-api',
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      'password_hash',
      'session_id',
      'sessionId',
      'authorization',
      'x-session-id',
      'req.headers.authorization',
      'req.headers["x-session-id"]',
    ],
    remove: true,
  },
});

export interface RequestContext {
  requestId?: string;
  userId?: string;
  [key: string]: unknown;
}

/** Create a child logger bound to a request's context (requestId, userId). */
export function createRequestLogger(context: RequestContext): pino.Logger {
  return logger.child({
    requestId: context.requestId,
    userId: context.userId,
    ...context,
  });
}

/** Format an amount in cents to a readable string for logs (e.g. "$12.50"). */
export function formatAmount(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}
