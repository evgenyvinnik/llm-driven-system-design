/**
 * Structured JSON logging using pino.
 * Provides consistent logging format with correlation IDs for distributed tracing.
 * All log entries include timestamp, level, and structured context.
 */
import pino from 'pino';
import { randomUUID } from 'crypto';

/**
 * Base logger instance configured for JSON output.
 * In development, uses pretty printing for readability.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'ticketmaster-api',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'SYS:standard',
      },
    },
  }),
});

/**
 * Creates a child logger with a unique correlation ID.
 * Use this for request-scoped logging to trace requests across services.
 *
 * @param correlationId - Optional correlation ID (generated if not provided)
 * @returns Child logger instance with correlation ID
 */
export function createRequestLogger(correlationId?: string) {
  return logger.child({
    correlationId: correlationId || randomUUID(),
  });
}

/**
 * Creates a child logger with additional context.
 *
 * @param context - Key-value pairs to include in all log entries
 * @returns Child logger instance with context
 */
export function createContextLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Standard business event log helpers.
 * These ensure consistent log structure for key business events.
 */
export const businessLogger = {
  seatReserved: (params: {
    correlationId: string;
    userId: string;
    eventId: string;
    seatIds: string[];
    durationMs: number;
  }) => {
    logger.info({
      action: 'seat_reserved',
      ...params,
    });
  },

  seatReleased: (params: {
    correlationId: string;
    userId?: string;
    eventId: string;
    seatIds: string[];
    reason: 'user_release' | 'timeout' | 'checkout_failed';
  }) => {
    logger.info({
      action: 'seat_released',
      ...params,
    });
  },

  checkoutCompleted: (params: {
    correlationId: string;
    userId: string;
    eventId: string;
    orderId: string;
    amount: number;
    durationMs: number;
  }) => {
    logger.info({
      action: 'checkout_completed',
      ...params,
    });
  },

  checkoutFailed: (params: {
    correlationId: string;
    userId: string;
    eventId?: string;
    reason: string;
    error?: string;
  }) => {
    logger.warn({
      action: 'checkout_failed',
      ...params,
    });
  },

  lockContention: (params: {
    eventId: string;
    seatId: string;
    attempts: number;
  }) => {
    logger.warn({
      action: 'lock_contention',
      ...params,
    });
  },

  oversellPrevented: (params: {
    eventId: string;
    seatId: string;
    details: string;
  }) => {
    logger.error({
      action: 'oversell_prevented',
      ...params,
    });
  },

  redisFallback: (params: { operation: string; error: string }) => {
    logger.error({
      action: 'redis_fallback',
      ...params,
    });
  },

  idempotencyHit: (params: {
    correlationId: string;
    idempotencyKey: string;
    orderId: string;
  }) => {
    logger.info({
      action: 'idempotency_hit',
      ...params,
    });
  },

  circuitBreakerStateChange: (params: {
    name: string;
    previousState: string;
    newState: string;
    failures: number;
  }) => {
    logger.warn({
      action: 'circuit_breaker_state_change',
      ...params,
    });
  },
};

export default logger;
