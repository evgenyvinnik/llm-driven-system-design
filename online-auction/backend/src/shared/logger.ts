import pino, { Logger } from 'pino';
import type { BidEventData, AuctionEventData, CacheEventData } from '../types.js';

// Configure pino logger with structured JSON logging
const logger: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => {
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
 */
export const createRequestLogger = (context: Record<string, unknown>): Logger => {
  return logger.child(context);
};

/**
 * Log a bid event with structured data
 */
export const logBidEvent = (data: BidEventData): void => {
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
 */
export const logAuctionEvent = (data: AuctionEventData): void => {
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
 */
export const logError = (error: Error, context: Record<string, unknown> = {}): void => {
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
 */
export const logCacheEvent = (data: CacheEventData): void => {
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
