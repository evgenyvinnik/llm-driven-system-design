import { pool } from '../../database.js';
import { quoteService } from '../quoteService.js';
import { logger } from '../../shared/logger.js';
import { fillOrder } from './execution.js';
import type { Order } from './types.js';

/**
 * Manages the background limit order matching process.
 *
 * @description This class implements a background order matching engine that
 * periodically scans for pending limit and stop orders and executes them when
 * market conditions meet the order criteria. The matcher runs on a configurable
 * interval (default: 2 seconds) and processes orders in FIFO order based on
 * creation time.
 *
 * Order matching rules:
 * - **Limit Buy**: Executes when ask price <= limit price
 * - **Limit Sell**: Executes when bid price >= limit price
 * - **Stop Buy**: Triggers when ask price >= stop price (breakout entry)
 * - **Stop Sell**: Triggers when bid price <= stop price (stop-loss)
 *
 * The matcher is designed for simulation purposes and executes orders at current
 * market prices rather than the limit price (price improvement).
 *
 * @example
 * ```typescript
 * const matcher = new LimitOrderMatcher();
 * matcher.start();
 * // ... trading operations ...
 * matcher.stop();
 * ```
 */
export class LimitOrderMatcher {
  private executionInterval: NodeJS.Timeout | null = null;

  /**
   * Starts the background limit order matcher.
   *
   * @description Initializes a periodic check (every 2 seconds) that scans for
   * pending limit and stop orders and executes them when market conditions are met.
   * If the matcher is already running, this method does nothing (idempotent).
   *
   * The matcher continues running until {@link stop} is called.
   *
   * @returns void
   */
  start(): void {
    if (this.executionInterval) return;

    this.executionInterval = setInterval(async () => {
      await this.matchLimitOrders();
    }, 2000);

    logger.info('Limit order matcher started');
  }

  /**
   * Stops the background limit order matcher.
   *
   * @description Clears the periodic interval and stops scanning for orders.
   * If the matcher is not running, this method does nothing (idempotent).
   * Any orders that are currently being processed will complete, but no new
   * matching cycles will be started.
   *
   * @returns void
   */
  stop(): void {
    if (this.executionInterval) {
      clearInterval(this.executionInterval);
      this.executionInterval = null;
      logger.info('Limit order matcher stopped');
    }
  }

  /**
   * Checks all pending limit/stop orders and executes matching ones.
   *
   * @description Queries the database for all orders with status 'pending', 'submitted',
   * or 'partial' that are of type 'limit', 'stop', or 'stop_limit'. For each order,
   * retrieves the current quote and checks if fill conditions are met:
   *
   * - **Limit Buy**: Executes when ask price <= limit price
   * - **Limit Sell**: Executes when bid price >= limit price
   * - **Stop Buy**: Triggers when ask price >= stop price
   * - **Stop Sell**: Triggers when bid price <= stop price
   *
   * Orders are processed in FIFO order (by creation time). If a quote is not available
   * for a symbol, that order is skipped. Errors during individual order fills are
   * caught and logged without stopping processing of other orders.
   *
   * @returns Promise that resolves when all eligible orders have been processed
   * @private
   */
  private async matchLimitOrders(): Promise<void> {
    try {
      // Get all pending/submitted limit orders
      const ordersResult = await pool.query<Order>(
        `SELECT * FROM orders
         WHERE status IN ('pending', 'submitted', 'partial')
         AND order_type IN ('limit', 'stop', 'stop_limit')
         ORDER BY created_at ASC`
      );

      for (const order of ordersResult.rows) {
        const quote = quoteService.getQuote(order.symbol);
        if (!quote) continue;

        const fillInfo = this.checkFillConditions(order, quote.ask, quote.bid);

        if (fillInfo.shouldFill) {
          const remainingQty = order.quantity - parseFloat(String(order.filled_quantity));
          try {
            await fillOrder(order, fillInfo.fillPrice, remainingQty);
            logger.info({ orderId: order.id, fillPrice: fillInfo.fillPrice }, 'Limit order filled');
          } catch (error) {
            logger.error({ orderId: order.id, error }, 'Error filling limit order');
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error matching limit orders');
    }
  }

  /**
   * Determines if an order should be filled based on current market prices.
   *
   * @description Evaluates whether an order's fill conditions are met by comparing
   * the order's limit/stop price against current market prices:
   *
   * - **Limit orders**: Check if the market price is at or better than the limit price
   *   - Buy: ask <= limit_price (can buy at target price or cheaper)
   *   - Sell: bid >= limit_price (can sell at target price or higher)
   *
   * - **Stop orders**: Check if the market has moved through the stop price
   *   - Buy: ask >= stop_price (price has risen to trigger level)
   *   - Sell: bid <= stop_price (price has fallen to trigger level)
   *
   * @param order - The order to check for fill conditions
   * @param askPrice - Current ask (offer) price for the symbol
   * @param bidPrice - Current bid price for the symbol
   * @returns Object containing:
   *   - shouldFill: true if the order should be executed
   *   - fillPrice: the price at which to fill (current market price, not limit price)
   * @private
   */
  private checkFillConditions(
    order: Order,
    askPrice: number,
    bidPrice: number
  ): { shouldFill: boolean; fillPrice: number } {
    let shouldFill = false;
    let fillPrice = 0;

    if (order.order_type === 'limit') {
      if (order.side === 'buy' && order.limit_price && askPrice <= order.limit_price) {
        shouldFill = true;
        fillPrice = askPrice;
      } else if (order.side === 'sell' && order.limit_price && bidPrice >= order.limit_price) {
        shouldFill = true;
        fillPrice = bidPrice;
      }
    } else if (order.order_type === 'stop') {
      if (order.side === 'buy' && order.stop_price && askPrice >= order.stop_price) {
        shouldFill = true;
        fillPrice = askPrice;
      } else if (order.side === 'sell' && order.stop_price && bidPrice <= order.stop_price) {
        shouldFill = true;
        fillPrice = bidPrice;
      }
    }

    return { shouldFill, fillPrice };
  }
}
