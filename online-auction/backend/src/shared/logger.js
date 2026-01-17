import pino from 'pino';

// Configure pino logger with structured JSON logging
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: process.env.SERVICE_NAME || 'auction-api',
    pid: process.pid,
  },
  // Use pino-pretty in development for readable logs
  transport:
    process.env.NODE_ENV !== 'production'
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
 * Create a child logger with request context
 * @param {object} context - Request context (correlationId, userId, etc.)
 * @returns {pino.Logger} Child logger with context
 */
export const createRequestLogger = (context) => {
  return logger.child(context);
};

/**
 * Log a bid event with structured data
 * @param {object} data - Bid event data
 */
export const logBidEvent = (data) => {
  logger.info(
    {
      action: 'bid_placed',
      auctionId: data.auctionId,
      bidderId: data.bidderId,
      amount: data.amount,
      isAutoBid: data.isAutoBid || false,
      durationMs: data.durationMs,
      idempotencyKey: data.idempotencyKey,
    },
    `Bid placed: $${data.amount} on auction ${data.auctionId}`
  );
};

/**
 * Log an auction event with structured data
 * @param {object} data - Auction event data
 */
export const logAuctionEvent = (data) => {
  logger.info(
    {
      action: data.action,
      auctionId: data.auctionId,
      sellerId: data.sellerId,
      winnerId: data.winnerId,
      finalPrice: data.finalPrice,
      durationMs: data.durationMs,
    },
    `Auction ${data.action}: ${data.auctionId}`
  );
};

/**
 * Log an error with structured data
 * @param {Error} error - Error object
 * @param {object} context - Additional context
 */
export const logError = (error, context = {}) => {
  logger.error(
    {
      err: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      ...context,
    },
    error.message
  );
};

/**
 * Log cache operations for observability
 * @param {object} data - Cache operation data
 */
export const logCacheEvent = (data) => {
  logger.debug(
    {
      action: data.action,
      key: data.key,
      hit: data.hit,
      durationMs: data.durationMs,
    },
    `Cache ${data.action}: ${data.key}`
  );
};

export default logger;
