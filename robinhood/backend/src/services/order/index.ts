import { pool } from '../../database.js';
import { quoteService } from '../quoteService.js';
import { logger } from '../../shared/logger.js';
import { auditLogger } from '../../shared/audit.js';
import { idempotencyService } from '../../shared/idempotency.js';
import { publishOrder, isProducerConnected } from '../../shared/kafka.js';
import {
  ordersPlacedTotal,
  ordersRejectedTotal,
  orderExecutionDurationMs,
} from '../../shared/metrics.js';

import { validateOrder } from './order-validation.js';
import { executeOrderImmediately, fillOrder } from './execution.js';
import { cancelOrder } from './order-cancellation.js';
import { getOrders, getOrder, getExecutions } from './order-queries.js';
import { LimitOrderMatcher } from './limit-orders.js';

import type {
  PlaceOrderRequest,
  OrderResult,
  OrderContext,
  Order,
  Execution,
} from './types.js';

/**
 * Re-export types for consumers of the order service.
 *
 * @description These types are re-exported to provide a single import point
 * for all order-related types used by API routes and other services.
 */
export type { PlaceOrderRequest, OrderResult, OrderContext } from './types.js';

/**
 * Service for managing stock orders in the trading platform.
 *
 * @description The OrderService is the central component for all order-related
 * operations. It provides a complete order management system including:
 *
 * - **Order Placement**: Create new buy/sell orders with support for market,
 *   limit, stop, and stop-limit order types
 * - **Idempotency**: Prevent duplicate orders using idempotency keys
 * - **Validation**: Ensure sufficient funds/shares before order placement
 * - **Execution**: Immediate execution for market orders, background matching
 *   for limit/stop orders
 * - **Cancellation**: Cancel pending orders and release reserved resources
 * - **Querying**: Retrieve orders and their execution history
 *
 * The service implements fund/share reservation to ensure transaction integrity.
 * When an order is placed, the required funds (for buys) or shares (for sells)
 * are reserved immediately. These are released upon fill or cancellation.
 *
 * Enhanced with:
 * - **Idempotency**: Prevents duplicate trades when network retries occur
 * - **Audit Logging**: Comprehensive logging for SEC compliance requirements
 * - **Prometheus Metrics**: Order counts, execution times, and values for monitoring
 * - **Kafka Events**: Publishes order and trade events for downstream processing
 *
 * @example
 * ```typescript
 * import { orderService } from './services/order';
 *
 * // Place a market buy order
 * const result = await orderService.placeOrder(userId, {
 *   symbol: 'AAPL',
 *   side: 'buy',
 *   order_type: 'market',
 *   quantity: 10,
 * });
 *
 * // Start background limit order matching
 * orderService.startLimitOrderMatcher();
 * ```
 */
export class OrderService {
  private limitOrderMatcher = new LimitOrderMatcher();

  /**
   * Places a new order for a user with idempotency support.
   *
   * @description Creates and processes a new stock order with the following workflow:
   * 1. **Idempotency Check**: If an idempotency key is provided, checks for existing
   *    order with the same key and returns cached result if found
   * 2. **Validation**: Validates symbol exists, quantity is positive, required prices
   *    are provided, and user has sufficient funds/shares
   * 3. **Order Creation**: Creates the order record in the database
   * 4. **Resource Reservation**: Reserves funds (for buys) or shares (for sells)
   * 5. **Execution**: For market orders, executes immediately; for limit/stop orders,
   *    the background matcher will process them when conditions are met
   * 6. **Event Publishing**: Publishes order events to Kafka for downstream processing
   *
   * The idempotency mechanism prevents duplicate orders when network retries occur.
   * If the same idempotency key is used for multiple requests, only the first request
   * creates an order; subsequent requests return the cached result.
   *
   * @param userId - Unique identifier of the user placing the order
   * @param request - Order details including symbol, side, order type, quantity,
   *   and optional limit/stop prices
   * @param context - Optional context including idempotency key, request ID, and
   *   client information for tracing and audit logging
   * @returns Promise resolving to order result containing the created order,
   *   execution details (for market orders), and a status message
   * @throws {Error} 'Invalid symbol: {symbol}' - If symbol is not found
   * @throws {Error} 'Quantity must be positive' - If quantity <= 0
   * @throws {Error} 'Insufficient buying power' - If user lacks funds for buy order
   * @throws {Error} 'Insufficient shares' - If user lacks shares for sell order
   * @throws {Error} 'Order placement already in progress' - If idempotency lock fails
   *
   * @example
   * ```typescript
   * // Place a limit buy order with idempotency
   * const result = await orderService.placeOrder(
   *   'user-123',
   *   {
   *     symbol: 'AAPL',
   *     side: 'buy',
   *     order_type: 'limit',
   *     quantity: 10,
   *     limit_price: 150.00,
   *   },
   *   {
   *     idempotencyKey: 'unique-request-id-123',
   *     requestId: 'trace-456',
   *   }
   * );
   * ```
   */
  async placeOrder(
    userId: string,
    request: PlaceOrderRequest,
    context: OrderContext = {}
  ): Promise<OrderResult> {
    const orderLogger = logger.child({
      userId,
      symbol: request.symbol,
      side: request.side,
      orderType: request.order_type,
      quantity: request.quantity,
      requestId: context.requestId,
    });

    const startTime = Date.now();

    // Check idempotency if key provided
    if (context.idempotencyKey) {
      const existing = await idempotencyService.check<OrderResult>(context.idempotencyKey, userId);

      if (existing) {
        if (existing.status === 'completed' && existing.result) {
          orderLogger.info({ idempotencyKey: context.idempotencyKey }, 'Returning cached order result (idempotent)');
          return { ...existing.result, idempotent: true };
        }

        if (existing.status === 'pending') {
          // Another request is in progress - wait or return error
          orderLogger.warn({ idempotencyKey: context.idempotencyKey }, 'Order placement already in progress');
          throw new Error('Order placement already in progress. Please wait and retry.');
        }

        // If failed, allow retry
      }

      // Acquire idempotency lock
      const locked = await idempotencyService.start(context.idempotencyKey, userId);
      if (!locked) {
        throw new Error('Order placement already in progress. Please wait and retry.');
      }
    }

    const client = await pool.connect();
    let orderId: string | undefined;

    try {
      await client.query('BEGIN');

      // Validate the order
      await validateOrder(client, userId, request);

      // Create the order
      const orderResult = await client.query<Order>(
        `INSERT INTO orders (user_id, symbol, side, order_type, quantity, limit_price, stop_price, time_in_force, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING *`,
        [
          userId,
          request.symbol.toUpperCase(),
          request.side,
          request.order_type,
          request.quantity,
          request.limit_price || null,
          request.stop_price || null,
          request.time_in_force || 'day',
        ]
      );

      const order = orderResult.rows[0];
      orderId = order.id;

      // Reserve funds or shares
      if (request.side === 'buy') {
        const quote = quoteService.getQuote(request.symbol);
        const estimatedCost = request.quantity * (request.limit_price || quote?.ask || 0);

        await client.query(
          `UPDATE users SET buying_power = buying_power - $1, updated_at = NOW()
           WHERE id = $2`,
          [estimatedCost, userId]
        );
      } else {
        // Reserve shares for sell
        await client.query(
          `UPDATE positions SET reserved_quantity = reserved_quantity + $1, updated_at = NOW()
           WHERE user_id = $2 AND symbol = $3`,
          [request.quantity, userId, request.symbol.toUpperCase()]
        );
      }

      await client.query('COMMIT');

      // Track metrics
      ordersPlacedTotal.inc({ side: request.side, order_type: request.order_type });

      // Audit log the order placement
      await auditLogger.logOrderPlaced(userId, order.id, {
        symbol: request.symbol.toUpperCase(),
        side: request.side,
        orderType: request.order_type,
        quantity: request.quantity,
        limitPrice: request.limit_price,
        stopPrice: request.stop_price,
        timeInForce: request.time_in_force || 'day',
      }, {
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        idempotencyKey: context.idempotencyKey,
      });

      // Publish order event to Kafka
      if (isProducerConnected()) {
        await publishOrder(order, 'placed', {
          requestId: context.requestId,
          idempotencyKey: context.idempotencyKey,
        });
      }

      orderLogger.info({ orderId: order.id }, 'Order placed successfully');

      let result: OrderResult;

      // For market orders, execute immediately (simulation)
      if (request.order_type === 'market') {
        result = await executeOrderImmediately(order, context);
      } else {
        result = { order, message: 'Order placed successfully' };
      }

      // Track execution duration for market orders
      const duration = Date.now() - startTime;
      orderExecutionDurationMs.observe({ order_type: request.order_type }, duration);

      // Cache result for idempotency
      if (context.idempotencyKey) {
        await idempotencyService.complete(context.idempotencyKey, userId, result);
      }

      return result;
    } catch (error) {
      await client.query('ROLLBACK');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      orderLogger.error({ error: errorMessage }, 'Order placement failed');

      // Track rejection metrics
      ordersRejectedTotal.inc({ reason: errorMessage.substring(0, 50) });

      // Audit log the rejection if we got far enough to have an order ID
      if (orderId) {
        await auditLogger.logOrderRejected(userId, orderId, errorMessage, {
          symbol: request.symbol.toUpperCase(),
          side: request.side,
          orderType: request.order_type,
          quantity: request.quantity,
        }, {
          requestId: context.requestId,
          idempotencyKey: context.idempotencyKey,
        });
      }

      // Mark idempotency as failed
      if (context.idempotencyKey) {
        await idempotencyService.fail(context.idempotencyKey, userId, errorMessage);
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fills an order (or partial order) at the specified price.
   *
   * @description Delegates to the execution module to process an order fill.
   * Creates an execution record, updates the order status and average fill price,
   * modifies the user's position, adjusts buying power, and publishes events.
   *
   * @param order - The order to fill
   * @param price - Execution price per share
   * @param quantity - Number of shares to fill (can be partial)
   * @param context - Optional order context for request tracing
   * @returns Promise resolving to order result with execution details
   * @throws {Error} Any database error during the fill transaction
   */
  async fillOrder(
    order: Order,
    price: number,
    quantity: number,
    context: OrderContext = {}
  ): Promise<OrderResult> {
    return fillOrder(order, price, quantity, context);
  }

  /**
   * Cancels a pending, submitted, or partially filled order.
   *
   * @description Delegates to the cancellation module to cancel an order.
   * Releases reserved funds (for buy orders) or shares (for sell orders)
   * back to the user's account.
   *
   * @param userId - Unique identifier of the order owner
   * @param orderId - Unique identifier of the order to cancel
   * @param context - Optional order context for request tracing
   * @returns Promise resolving to the cancelled order with updated status
   * @throws {Error} 'Order not found' - If order does not exist or belongs to another user
   * @throws {Error} 'Cannot cancel order with status: {status}' - If order cannot be cancelled
   */
  async cancelOrder(
    userId: string,
    orderId: string,
    context: OrderContext = {}
  ): Promise<Order> {
    return cancelOrder(userId, orderId, context);
  }

  /**
   * Retrieves all orders for a user, optionally filtered by status.
   *
   * @description Fetches the user's order history from the database, sorted
   * by creation date with newest orders first.
   *
   * @param userId - Unique identifier of the order owner
   * @param status - Optional status filter (pending, filled, cancelled, etc.)
   * @returns Promise resolving to an array of orders
   */
  async getOrders(userId: string, status?: string): Promise<Order[]> {
    return getOrders(userId, status);
  }

  /**
   * Retrieves a specific order for a user.
   *
   * @description Fetches a single order by ID, ensuring ownership by the
   * specified user for security.
   *
   * @param userId - Unique identifier of the order owner
   * @param orderId - Unique identifier of the order to retrieve
   * @returns Promise resolving to the order if found, or null if not found
   *   or belonging to a different user
   */
  async getOrder(userId: string, orderId: string): Promise<Order | null> {
    return getOrder(userId, orderId);
  }

  /**
   * Retrieves all executions for an order.
   *
   * @description Fetches all execution records (fills) associated with a
   * specific order. Each execution represents a partial or complete fill.
   *
   * @param orderId - Unique identifier of the order
   * @returns Promise resolving to an array of executions, sorted by
   *   execution time with most recent first
   */
  async getExecutions(orderId: string): Promise<Execution[]> {
    return getExecutions(orderId);
  }

  /**
   * Starts the background limit order matcher.
   *
   * @description Initiates periodic scanning (every 2 seconds) for pending
   * limit and stop orders. When market conditions match order criteria,
   * the matcher automatically executes the orders. Call this method when
   * the application starts to enable limit order processing.
   *
   * @returns void
   */
  startLimitOrderMatcher(): void {
    this.limitOrderMatcher.start();
  }

  /**
   * Stops the background limit order matcher.
   *
   * @description Halts the periodic scanning for limit and stop orders.
   * Any orders currently being processed will complete, but no new matching
   * cycles will start. Call this method during graceful shutdown.
   *
   * @returns void
   */
  stopLimitOrderMatcher(): void {
    this.limitOrderMatcher.stop();
  }
}

/**
 * Singleton instance of the OrderService.
 *
 * @description Pre-instantiated OrderService for use throughout the application.
 * Import this instance rather than creating new OrderService instances to ensure
 * consistent state management (especially for the limit order matcher).
 *
 * @example
 * ```typescript
 * import { orderService } from './services/order';
 *
 * // Use the singleton instance
 * const orders = await orderService.getOrders(userId);
 * ```
 */
export const orderService = new OrderService();
