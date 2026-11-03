import http from 'http';
import { app, sessionMiddleware } from './app.js';
import { config } from './config/index.js';
import { wsManager } from './websocket.js';
import { marketService } from './services/marketService.js';
import { logger } from './services/logger.js';
import { ensureExchangeAccount } from './services/exchangeAccount.js';
import {
  checkStopTriggers,
  orderEvents,
  rehydrateOrderBooks,
  type OrderUpdateEvent,
} from './services/orderService.js';

const server = http.createServer(app);

// Initialize WebSocket
wsManager.initialize(server, sessionMiddleware);

// Order state changes go to the owner's private channel only.
orderEvents.on('order_update', (event: OrderUpdateEvent) => {
  wsManager.sendToUser(event.userId, {
    type: 'order_update',
    orderId: event.orderId,
    symbol: event.symbol,
    status: event.status,
    timestamp: Date.now(),
  });
});

// Price broadcasting on the main server (for WebSocket clients)
const BROADCAST_INTERVAL = 2000;

setInterval(() => {
  const symbols = marketService.getAllSymbols();
  for (const symbol of symbols) {
    const priceData = marketService.simulatePriceTick(symbol);
    if (priceData) {
      checkStopTriggers(symbol);

      // Broadcast to ticker subscribers
      wsManager.broadcast(`ticker:${symbol}`, {
        type: 'ticker',
        symbol,
        price: priceData.price,
        change24h: priceData.change24h,
        changePercent24h: priceData.changePercent24h,
        volume24h: priceData.volume24h,
        high24h: priceData.high24h,
        low24h: priceData.low24h,
        timestamp: Date.now(),
      });
    }
  }

  // Broadcast all prices summary
  const allPrices: Record<string, unknown> = {};
  const prices = marketService.getAllPrices();
  for (const [symbol, data] of prices) {
    allPrices[symbol] = data;
  }
  wsManager.broadcastToAll({
    type: 'prices',
    data: allPrices,
    timestamp: Date.now(),
  });
}, BROADCAST_INTERVAL);

/**
 * The book must be rebuilt before the first order arrives: a resting order
 * that is live in Postgres but missing from memory would never match, and a
 * new order could trade through it. Postgres may still be starting, so retry.
 */
async function prepareMatchingEngine(): Promise<void> {
  const attempts = 15;
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureExchangeAccount();
      const counts = await rehydrateOrderBooks();
      logger.info(counts, 'Order books rebuilt from Postgres');
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.warn({ err: error, attempt }, 'Database not ready; retrying engine startup');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

prepareMatchingEngine()
  .then(() => {
    server.listen(config.port, () => {
      logger.info(`Coinbase API server running on port ${config.port}`);
      logger.info(`WebSocket server running on ws://localhost:${config.port}/ws`);
      logger.info(`Health check: http://localhost:${config.port}/api/v1/health`);
    });
  })
  .catch((error) => {
    logger.fatal({ err: error }, 'Could not rebuild order books; refusing to serve');
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});
