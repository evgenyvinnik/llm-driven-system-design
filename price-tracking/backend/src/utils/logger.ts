/**
 * Structured JSON logger using pino for the Price Tracking service.
 * Provides fast, low-overhead logging with structured output suitable
 * for log aggregation systems like ELK, Loki, or CloudWatch.
 * @module utils/logger
 */
import pino from 'pino';

/**
 * Log level configuration based on environment.
 * Development uses 'debug' for more verbose output.
 * Production uses 'info' to reduce log volume.
 */
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

/**
 * Configure pino transport based on environment.
 * Development: pretty-print for human readability
 * Production: JSON for log aggregation
 */
const transport = process.env.NODE_ENV === 'production'
  ? undefined  // Default JSON output for production
  : {
      target: 'pino/file',
      options: {
        destination: 1,  // stdout
      },
    };

/**
 * Main pino logger instance configured for the Price Tracking service.
 * All modules should import this logger for consistent structured output.
 *
 * Log format includes:
 * - level: Log level (info, warn, error, debug)
 * - time: ISO 8601 timestamp
 * - service: Service name for filtering in aggregators
 * - requestId: Request correlation ID (when available)
 * - Additional context fields as needed
 */
const logger = pino({
  name: 'price-tracker',
  level: logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      service: 'price-tracker',
      pid: bindings.pid,
      hostname: bindings.hostname,
    }),
  },
  // Redact sensitive fields from logs
  redact: {
    paths: ['password', 'password_hash', 'token', 'authorization', 'cookie'],
    censor: '[REDACTED]',
  },
  // Base context included in all logs
  base: {
    env: process.env.NODE_ENV || 'development',
  },
  transport,
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-scoped context like requestId.
 * @param context - Additional context to include in all logs from this child
 * @returns A child logger instance
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Creates a request-scoped logger with request ID for tracing.
 * @param requestId - Unique request identifier
 * @returns A child logger with requestId context
 */
export function createRequestLogger(requestId: string): pino.Logger {
  return logger.child({ requestId });
}

/**
 * Helper to log scrape operations with consistent structure.
 * @param domain - The domain being scraped
 * @param productId - The product ID
 * @param status - Scrape status (success, failure, etc.)
 * @param durationMs - Duration in milliseconds
 * @param error - Optional error message
 */
export function logScrape(
  domain: string,
  productId: string,
  status: 'success' | 'failure' | 'retry' | 'circuit_open',
  durationMs: number,
  error?: string
): void {
  const logData = {
    action: 'scrape',
    domain,
    productId,
    status,
    durationMs,
    ...(error && { error }),
  };

  if (status === 'success') {
    logger.info(logData, `Scrape completed for ${domain}`);
  } else if (status === 'retry') {
    logger.warn(logData, `Retrying scrape for ${domain}`);
  } else {
    logger.error(logData, `Scrape failed for ${domain}`);
  }
}

/**
 * Helper to log alert operations with consistent structure.
 * @param userId - The user receiving the alert
 * @param productId - The product that triggered the alert
 * @param alertType - Type of alert (target_reached, price_drop, etc.)
 * @param oldPrice - Previous price
 * @param newPrice - New price
 */
export function logAlert(
  userId: string,
  productId: string,
  alertType: string,
  oldPrice: number | null,
  newPrice: number
): void {
  logger.info(
    {
      action: 'alert_triggered',
      userId,
      productId,
      alertType,
      oldPrice,
      newPrice,
      priceDrop: oldPrice ? oldPrice - newPrice : null,
    },
    `Alert triggered: ${alertType}`
  );
}

/**
 * Helper to log price changes with consistent structure.
 * @param productId - The product ID
 * @param oldPrice - Previous price
 * @param newPrice - New price
 * @param changePct - Percentage change
 */
export function logPriceChange(
  productId: string,
  oldPrice: number,
  newPrice: number,
  changePct: number
): void {
  logger.info(
    {
      action: 'price_change',
      productId,
      oldPrice,
      newPrice,
      changePct: Math.round(changePct * 100) / 100,
      direction: newPrice > oldPrice ? 'up' : 'down',
    },
    `Price changed: $${oldPrice} -> $${newPrice} (${changePct.toFixed(2)}%)`
  );
}

/**
 * Helper to log circuit breaker state changes.
 * @param domain - The domain whose circuit changed
 * @param fromState - Previous state
 * @param toState - New state
 * @param reason - Reason for the transition
 */
export function logCircuitBreaker(
  domain: string,
  fromState: string,
  toState: string,
  reason?: string
): void {
  logger.warn(
    {
      action: 'circuit_breaker_transition',
      domain,
      fromState,
      toState,
      reason,
    },
    `Circuit breaker ${fromState} -> ${toState} for ${domain}`
  );
}

export default logger;
