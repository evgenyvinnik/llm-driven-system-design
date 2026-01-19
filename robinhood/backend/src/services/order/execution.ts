import { pool } from '../../database.js';
import { quoteService } from '../quoteService.js';
import { logger } from '../../shared/logger.js';
import { auditLogger } from '../../shared/audit.js';
import { publishOrder, publishTrade, isProducerConnected } from '../../shared/kafka.js';
import {
  ordersFilledTotal,
  executionValueTotal,
  executionSharesTotal,
  portfolioUpdatesTotal,
} from '../../shared/metrics.js';
import { updatePositionForBuy, updatePositionForSell } from './position-updates.js';
import type { Order, Execution, OrderContext, OrderResult } from './types.js';

/**
 * Executes a market order immediately at the current market price.
 *
 * @description Retrieves the current quote for the order's symbol and executes
 * the order at the ask price (for buys) or bid price (for sells). This function
 * is used for market orders that should be filled immediately at the best
 * available price.
 *
 * @param order - The order to execute (must be a market order)
 * @param context - Optional order context for request tracing and idempotency
 * @returns Promise resolving to the order result with execution details
 * @throws {Error} 'Quote not available' - If no quote exists for the order's symbol
 */
export async function executeOrderImmediately(
  order: Order,
  context: OrderContext = {}
): Promise<OrderResult> {
  const quote = quoteService.getQuote(order.symbol);
  if (!quote) {
    throw new Error('Quote not available');
  }

  const fillPrice = order.side === 'buy' ? quote.ask : quote.bid;

  return await fillOrder(order, fillPrice, order.quantity, context);
}

/**
 * Fills an order (or partial order) at the specified price.
 *
 * @description Performs a complete order fill workflow within a database transaction:
 * 1. Creates an execution record with fill details
 * 2. Updates the order status (filled/partial) and average fill price
 * 3. Updates the user's position (adds shares for buys, removes for sells)
 * 4. Adjusts the user's buying power:
 *    - For buys: refunds any price difference if filled below estimate
 *    - For sells: adds sale proceeds to buying power
 * 5. Publishes order and trade events to Kafka (if connected)
 * 6. Logs audit trail and updates Prometheus metrics
 *
 * Supports both full and partial fills. The order status is set to 'filled'
 * when the entire quantity is filled, or 'partial' for partial fills.
 *
 * @param order - The order to fill (can be any order type)
 * @param price - Execution price per share
 * @param quantity - Number of shares to fill (can be less than order quantity for partial fills)
 * @param context - Optional order context for request tracing
 * @returns Promise resolving to order result with execution details and updated order
 * @throws {Error} Any database error during the transaction (transaction is rolled back)
 */
export async function fillOrder(
  order: Order,
  price: number,
  quantity: number,
  context: OrderContext = {}
): Promise<OrderResult> {
  const client = await pool.connect();
  const fillLogger = logger.child({
    orderId: order.id,
    userId: order.user_id,
    symbol: order.symbol,
    side: order.side,
    fillPrice: price,
    fillQuantity: quantity,
    requestId: context.requestId,
  });

  try {
    await client.query('BEGIN');

    // Create execution record
    const execResult = await client.query<Execution>(
      `INSERT INTO executions (order_id, quantity, price, exchange)
       VALUES ($1, $2, $3, 'SIMULATOR')
       RETURNING *`,
      [order.id, quantity, price]
    );

    const execution = execResult.rows[0];

    // Update order
    const newFilledQty = parseFloat(String(order.filled_quantity)) + quantity;
    const isFullyFilled = newFilledQty >= order.quantity;

    // Calculate new average fill price
    const oldTotal = parseFloat(String(order.filled_quantity)) * (order.avg_fill_price || 0);
    const newTotal = oldTotal + quantity * price;
    const newAvgPrice = newTotal / newFilledQty;

    const newStatus = isFullyFilled ? 'filled' : 'partial';

    await client.query(
      `UPDATE orders
       SET filled_quantity = $1, avg_fill_price = $2, status = $3,
           filled_at = CASE WHEN $3 = 'filled' THEN NOW() ELSE filled_at END,
           submitted_at = COALESCE(submitted_at, NOW()),
           updated_at = NOW()
       WHERE id = $4`,
      [newFilledQty, newAvgPrice, newStatus, order.id]
    );

    // Update position
    if (order.side === 'buy') {
      await updatePositionForBuy(client, order.user_id, order.symbol, quantity, price);
      portfolioUpdatesTotal.inc({ type: 'buy' });
    } else {
      await updatePositionForSell(client, order.user_id, order.symbol, quantity, price);
      portfolioUpdatesTotal.inc({ type: 'sell' });
    }

    // Adjust buying power for actual fill
    if (order.side === 'buy') {
      // If filled at a lower price, return the difference
      const quote = quoteService.getQuote(order.symbol);
      const estimatedPrice = order.limit_price || quote?.ask || price;
      const priceDiff = estimatedPrice - price;

      if (priceDiff > 0) {
        await client.query(
          `UPDATE users SET buying_power = buying_power + $1, updated_at = NOW()
           WHERE id = $2`,
          [priceDiff * quantity, order.user_id]
        );
      }
    } else {
      // For sells, add proceeds to buying power
      await client.query(
        `UPDATE users SET buying_power = buying_power + $1, updated_at = NOW()
         WHERE id = $2`,
        [price * quantity, order.user_id]
      );
    }

    await client.query('COMMIT');

    // Track metrics
    ordersFilledTotal.inc({ side: order.side, order_type: order.order_type });
    executionValueTotal.inc({ side: order.side }, price * quantity);
    executionSharesTotal.inc({ side: order.side }, quantity);

    // Audit log the fill
    await auditLogger.logOrderFilled(order.user_id, order.id, {
      executionId: execution.id,
      symbol: order.symbol,
      side: order.side,
      quantity,
      price,
      totalValue: price * quantity,
      isFullyFilled,
      avgFillPrice: newAvgPrice,
    }, { requestId: context.requestId });

    const fillStatusMsg = isFullyFilled ? 'filled' : 'partially filled';
    fillLogger.info({ executionId: execution.id }, `Order ${fillStatusMsg}`);

    // Fetch updated order
    const updatedOrderResult = await pool.query<Order>(
      'SELECT * FROM orders WHERE id = $1',
      [order.id]
    );

    const updatedOrder = updatedOrderResult.rows[0];

    // Publish order fill event to Kafka
    if (isProducerConnected()) {
      const orderEventType = isFullyFilled ? 'filled' : 'partial';
      await publishOrder(updatedOrder, orderEventType, {
        executionId: execution.id,
        price,
        quantity,
        requestId: context.requestId,
      });

      // Publish trade event for portfolio updates
      await publishTrade(execution, updatedOrder, {
        isFullyFilled,
        avgFillPrice: newAvgPrice,
        requestId: context.requestId,
      });
    }

    return {
      order: updatedOrder,
      execution,
      message: `Order ${fillStatusMsg} at $${price.toFixed(2)}`,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    fillLogger.error({ error }, 'Order fill failed');
    throw error;
  } finally {
    client.release();
  }
}
