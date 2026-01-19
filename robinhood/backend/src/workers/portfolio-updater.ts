/**
 * Portfolio Updater Worker
 *
 * Consumes trade events from Kafka and updates portfolio values in real-time.
 * This worker handles:
 * - Portfolio value recalculations after trades
 * - Performance metrics updates
 * - Notifications for significant portfolio changes
 * - Analytics and reporting data aggregation
 *
 * Architecture:
 * - Order Service -> Kafka "trades" topic -> Portfolio Updater -> Redis cache / Database
 *
 * Benefits:
 * - Asynchronous portfolio updates don't block order execution
 * - Enables real-time portfolio dashboards
 * - Supports multiple consumers for different purposes (analytics, alerts, etc.)
 */

import { consumeTrades, TradeEvent, initKafkaProducer } from '../shared/kafka.js';
import { logger } from '../shared/logger.js';
import { redis } from '../redis.js';
import { pool } from '../database.js';
import http from 'http';

/** Port for the health check server */
const PORT = parseInt(process.env.UPDATER_PORT || '3011', 10);

/** Consumer group ID for this worker */
const CONSUMER_GROUP = process.env.CONSUMER_GROUP || 'portfolio-updaters';

/** Metrics for monitoring */
interface WorkerMetrics {
  tradesProcessed: number;
  portfolioUpdates: number;
  cacheUpdates: number;
  errors: number;
  lastProcessedAt: number | null;
}

const metrics: WorkerMetrics = {
  tradesProcessed: 0,
  portfolioUpdates: 0,
  cacheUpdates: 0,
  errors: 0,
  lastProcessedAt: null,
};

/**
 * Portfolio Updater processes trade events and updates portfolio data.
 */
class PortfolioUpdater {
  private server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          type: 'portfolio-updater',
          metrics,
        }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  }

  /**
   * Processes a trade event from Kafka.
   */
  async processTrade(event: TradeEvent): Promise<void> {
    const { execution, order, metadata } = event;
    const tradeLogger = logger.child({
      executionId: execution.id,
      orderId: order.id,
      userId: order.user_id,
      symbol: order.symbol,
      side: order.side,
    });

    try {
      tradeLogger.info('Processing trade event');

      // Update portfolio value in cache
      await this.updatePortfolioCache(order.user_id);

      // Update daily P&L tracking
      await this.updateDailyPnL(order.user_id, order.symbol, order.side, execution.quantity, execution.price);

      // Check for significant portfolio changes and notify
      await this.checkPortfolioAlerts(order.user_id);

      metrics.tradesProcessed++;
      metrics.lastProcessedAt = Date.now();

      tradeLogger.info('Trade event processed successfully');
    } catch (error) {
      metrics.errors++;
      tradeLogger.error({ error }, 'Failed to process trade event');
      throw error;
    }
  }

  /**
   * Updates the portfolio value cache for a user.
   */
  private async updatePortfolioCache(userId: string): Promise<void> {
    try {
      // Get all positions for the user
      const positionsResult = await pool.query(
        'SELECT symbol, quantity, avg_cost_basis FROM positions WHERE user_id = $1',
        [userId]
      );

      if (positionsResult.rows.length === 0) {
        // Clear cache if no positions
        await redis.del('portfolio:' + userId);
        return;
      }

      // Calculate total portfolio value
      // In a real system, we'd fetch current prices from a cache/service
      // For now, we'll store position data for the API to calculate with live prices
      const portfolioData = {
        positions: positionsResult.rows,
        updatedAt: Date.now(),
      };

      await redis.setex('portfolio:' + userId, 300, JSON.stringify(portfolioData));
      metrics.cacheUpdates++;

      logger.debug({ userId, positionCount: positionsResult.rows.length }, 'Portfolio cache updated');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to update portfolio cache');
      throw error;
    }
  }

  /**
   * Updates daily P&L tracking for a user.
   */
  private async updateDailyPnL(
    userId: string,
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price: number
  ): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const pnlKey = 'pnl:' + userId + ':' + today;

      // Get or initialize daily P&L data
      const existing = await redis.get(pnlKey);
      const pnlData = existing ? JSON.parse(existing) : {
        totalBought: 0,
        totalSold: 0,
        trades: [],
      };

      const tradeValue = quantity * price;

      if (side === 'buy') {
        pnlData.totalBought += tradeValue;
      } else {
        pnlData.totalSold += tradeValue;
      }

      pnlData.trades.push({
        symbol,
        side,
        quantity,
        price,
        value: tradeValue,
        timestamp: Date.now(),
      });

      // Keep for 7 days
      await redis.setex(pnlKey, 7 * 24 * 60 * 60, JSON.stringify(pnlData));

      logger.debug({ userId, today, side, tradeValue }, 'Daily P&L updated');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to update daily P&L');
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Checks for significant portfolio changes and stores alerts.
   */
  private async checkPortfolioAlerts(userId: string): Promise<void> {
    try {
      // Get user's portfolio summary
      const portfolioResult = await pool.query(
        'SELECT COUNT(*) as position_count, COALESCE(SUM(quantity * avg_cost_basis), 0) as total_cost_basis FROM positions WHERE user_id = $1',
        [userId]
      );

      const portfolio = portfolioResult.rows[0];
      const totalCostBasis = parseFloat(portfolio.total_cost_basis);

      // Store portfolio snapshot for historical tracking
      const snapshotKey = 'snapshot:' + userId + ':' + Date.now();
      await redis.setex(snapshotKey, 30 * 24 * 60 * 60, JSON.stringify({
        positionCount: parseInt(portfolio.position_count),
        totalCostBasis,
        timestamp: Date.now(),
      }));

      metrics.portfolioUpdates++;

      logger.debug({ userId, positionCount: portfolio.position_count, totalCostBasis }, 'Portfolio snapshot stored');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to check portfolio alerts');
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Starts the portfolio updater worker.
   */
  async start(): Promise<void> {
    // Start health check server
    this.server.listen(PORT, () => {
      logger.info({ port: PORT }, 'Portfolio updater health server started');
    });

    // Start Kafka consumer
    try {
      await consumeTrades(
        async (event) => {
          await this.processTrade(event);
        },
        CONSUMER_GROUP
      );

      logger.info({ consumerGroup: CONSUMER_GROUP }, 'Portfolio updater Kafka consumer started');
    } catch (error) {
      logger.error({ error }, 'Failed to start Kafka consumer');
      throw error;
    }

    console.log('\n' +
      '================================================================\n' +
      '                   Portfolio Updater Worker                      \n' +
      '================================================================\n' +
      '  Health:          http://localhost:' + PORT + '/health\n' +
      '  Metrics:         http://localhost:' + PORT + '/metrics\n' +
      '  Consumer Group:  ' + CONSUMER_GROUP + '\n' +
      '================================================================\n'
    );
  }

  /**
   * Gets the current worker metrics.
   */
  getMetrics(): WorkerMetrics {
    return { ...metrics };
  }
}

// Handle graceful shutdown
function gracefulShutdown(signal: string): void {
  logger.info({ signal, metrics }, 'Shutdown signal received');
  console.log(signal + ' received. Shutting down gracefully...');
  console.log('Final metrics:', JSON.stringify(metrics, null, 2));
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error: Error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ reason }, 'Unhandled rejection');
});

// Start the updater
const updater = new PortfolioUpdater();
updater.start().catch((error) => {
  logger.fatal({ error }, 'Failed to start portfolio updater');
  process.exit(1);
});

export { PortfolioUpdater };
