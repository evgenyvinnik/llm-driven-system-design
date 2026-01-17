import { pool } from '../database.js';
import { PoolClient } from 'pg';
import { quoteService } from './quoteService.js';
import type { Position, Order, Execution } from '../types/index.js';
import { logger } from '../shared/logger.js';
import { auditLogger } from '../shared/audit.js';
import { idempotencyService } from '../shared/idempotency.js';
import {
  ordersPlacedTotal,
  ordersFilledTotal,
  ordersCancelledTotal,
  ordersRejectedTotal,
  orderExecutionDurationMs,
  executionValueTotal,
  executionSharesTotal,
  portfolioUpdatesTotal,
} from '../shared/metrics.js';

/**
 * Request payload for placing a new order.
 */
export interface PlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  order_type: 'market' | 'limit' | 'stop' | 'stop_limit';
  quantity: number;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: 'day' | 'gtc' | 'ioc' | 'fok';
}

/**
 * Result returned after placing or executing an order.
 */
export interface OrderResult {
  order: Order;
  execution?: Execution;
  message: string;
  /** Indicates if this result was returned from idempotency cache */
  idempotent?: boolean;
}

/**
 * Context for order placement including idempotency and tracing.
 */
export interface OrderContext {
  /** Idempotency key to prevent duplicate orders */
  idempotencyKey?: string;
  /** Request ID for tracing */
  requestId?: string;
  /** Client IP address */
  ipAddress?: string;
  /** Client user agent */
  userAgent?: string;
}

/**
 * Service for managing stock orders.
 * Handles order placement, validation, execution, and cancellation.
 * Implements fund/share reservation to ensure transaction integrity.
 * Includes a background limit order matcher for non-market orders.
 *
 * Enhanced with:
 * - Idempotency to prevent duplicate trades
 * - Audit logging for SEC compliance
 * - Prometheus metrics for monitoring
 */
export class OrderService {
  private executionInterval: NodeJS.Timeout | null = null;

  /**
   * Places a new order for a user with idempotency support.
   * If an idempotency key is provided and a matching order exists,
   * returns the cached result instead of placing a duplicate order.
   *
   * @param userId - ID of the user placing the order
   * @param request - Order details including symbol, side, type, and quantity
   * @param context - Optional context including idempotency key and request tracing
   * @returns Promise resolving to order result with execution details
   * @throws Error if validation fails (insufficient funds, invalid symbol, etc.)
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
      await this.validateOrder(client, userId, request);

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

      orderLogger.info({ orderId: order.id }, 'Order placed successfully');

      let result: OrderResult;

      // For market orders, execute immediately (simulation)
      if (request.order_type === 'market') {
        result = await this.executeOrderImmediately(order, context);
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
   * Validates an order before placement.
   * Checks symbol validity, quantity, required prices for order type,
   * and sufficient funds (buy) or shares (sell).
   * Uses FOR UPDATE locks to prevent race conditions.
   * @param client - Database client within transaction
   * @param userId - ID of the user placing the order
   * @param request - Order details to validate
   * @throws Error with descriptive message if validation fails
   */
  private async validateOrder(
    client: PoolClient,
    userId: string,
    request: PlaceOrderRequest
  ): Promise<void> {
    // Check if symbol exists
    const quote = quoteService.getQuote(request.symbol);
    if (!quote) {
      throw new Error(`Invalid symbol: ${request.symbol}`);
    }

    // Validate quantity
    if (request.quantity <= 0) {
      throw new Error('Quantity must be positive');
    }

    // For limit orders, validate limit price
    if ((request.order_type === 'limit' || request.order_type === 'stop_limit') && !request.limit_price) {
      throw new Error('Limit price required for limit orders');
    }

    // For stop orders, validate stop price
    if ((request.order_type === 'stop' || request.order_type === 'stop_limit') && !request.stop_price) {
      throw new Error('Stop price required for stop orders');
    }

    if (request.side === 'buy') {
      // Check buying power
      const userResult = await client.query(
        'SELECT buying_power FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const buyingPower = parseFloat(userResult.rows[0].buying_power);
      const estimatedCost = request.quantity * (request.limit_price || quote.ask);

      if (buyingPower < estimatedCost) {
        throw new Error(`Insufficient buying power. Required: $${estimatedCost.toFixed(2)}, Available: $${buyingPower.toFixed(2)}`);
      }
    } else {
      // Check available shares for sell
      const positionResult = await client.query(
        'SELECT quantity, reserved_quantity FROM positions WHERE user_id = $1 AND symbol = $2 FOR UPDATE',
        [userId, request.symbol.toUpperCase()]
      );

      if (positionResult.rows.length === 0) {
        throw new Error(`No position in ${request.symbol}`);
      }

      const position = positionResult.rows[0];
      const availableShares = parseFloat(position.quantity) - parseFloat(position.reserved_quantity);

      if (availableShares < request.quantity) {
        throw new Error(`Insufficient shares. Required: ${request.quantity}, Available: ${availableShares}`);
      }
    }
  }

  /**
   * Executes a market order immediately at current market price.
   * @param order - Order to execute
   * @param context - Order context for tracing
   * @returns Promise resolving to order result with execution
   * @throws Error if quote is not available
   */
  private async executeOrderImmediately(order: Order, context: OrderContext = {}): Promise<OrderResult> {
    const quote = quoteService.getQuote(order.symbol);
    if (!quote) {
      throw new Error('Quote not available');
    }

    const fillPrice = order.side === 'buy' ? quote.ask : quote.bid;

    return await this.fillOrder(order, fillPrice, order.quantity, context);
  }

  /**
   * Fills an order (or partial order) at the specified price.
   * Creates execution record, updates order status, modifies positions,
   * and adjusts buying power. Handles both full and partial fills.
   * @param order - Order to fill
   * @param price - Execution price per share
   * @param quantity - Number of shares to fill
   * @param context - Order context for tracing
   * @returns Promise resolving to order result with execution details
   */
  async fillOrder(order: Order, price: number, quantity: number, context: OrderContext = {}): Promise<OrderResult> {
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

      await client.query(
        `UPDATE orders
         SET filled_quantity = $1, avg_fill_price = $2, status = $3,
             filled_at = CASE WHEN $3 = 'filled' THEN NOW() ELSE filled_at END,
             submitted_at = COALESCE(submitted_at, NOW()),
             updated_at = NOW()
         WHERE id = $4`,
        [newFilledQty, newAvgPrice, isFullyFilled ? 'filled' : 'partial', order.id]
      );

      // Update position
      if (order.side === 'buy') {
        await this.updatePositionForBuy(client, order.user_id, order.symbol, quantity, price);
        portfolioUpdatesTotal.inc({ type: 'buy' });
      } else {
        await this.updatePositionForSell(client, order.user_id, order.symbol, quantity, price);
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

      fillLogger.info({ executionId: execution.id }, `Order ${isFullyFilled ? 'filled' : 'partially filled'}`);

      // Fetch updated order
      const updatedOrderResult = await pool.query<Order>(
        'SELECT * FROM orders WHERE id = $1',
        [order.id]
      );

      return {
        order: updatedOrderResult.rows[0],
        execution,
        message: `Order ${isFullyFilled ? 'filled' : 'partially filled'} at $${price.toFixed(2)}`,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      fillLogger.error({ error }, 'Order fill failed');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Updates or creates a position after a buy order fill.
   * Calculates new average cost basis when adding to existing position.
   * @param client - Database client within transaction
   * @param userId - ID of the position owner
   * @param symbol - Stock ticker symbol
   * @param quantity - Number of shares purchased
   * @param price - Purchase price per share
   */
  private async updatePositionForBuy(
    client: PoolClient,
    userId: string,
    symbol: string,
    quantity: number,
    price: number
  ): Promise<void> {
    // Check if position exists
    const posResult = await client.query<Position>(
      'SELECT * FROM positions WHERE user_id = $1 AND symbol = $2 FOR UPDATE',
      [userId, symbol]
    );

    if (posResult.rows.length === 0) {
      // Create new position
      await client.query(
        `INSERT INTO positions (user_id, symbol, quantity, avg_cost_basis)
         VALUES ($1, $2, $3, $4)`,
        [userId, symbol, quantity, price]
      );
    } else {
      // Update existing position
      const position = posResult.rows[0];
      const oldQty = parseFloat(String(position.quantity));
      const oldCost = parseFloat(String(position.avg_cost_basis));
      const newQty = oldQty + quantity;
      const newAvgCost = (oldQty * oldCost + quantity * price) / newQty;

      await client.query(
        `UPDATE positions SET quantity = $1, avg_cost_basis = $2, updated_at = NOW()
         WHERE id = $3`,
        [newQty, newAvgCost, position.id]
      );
    }
  }

  /**
   * Updates a position after a sell order fill.
   * Decreases quantity and reserved shares; removes position if fully sold.
   * @param client - Database client within transaction
   * @param userId - ID of the position owner
   * @param symbol - Stock ticker symbol
   * @param quantity - Number of shares sold
   * @param _price - Sale price per share (unused, for signature consistency)
   */
  private async updatePositionForSell(
    client: PoolClient,
    userId: string,
    symbol: string,
    quantity: number,
    _price: number
  ): Promise<void> {
    const posResult = await client.query<Position>(
      'SELECT * FROM positions WHERE user_id = $1 AND symbol = $2 FOR UPDATE',
      [userId, symbol]
    );

    if (posResult.rows.length === 0) {
      throw new Error('Position not found');
    }

    const position = posResult.rows[0];
    const newQty = parseFloat(String(position.quantity)) - quantity;
    const newReserved = Math.max(0, parseFloat(String(position.reserved_quantity)) - quantity);

    if (newQty <= 0) {
      // Remove position entirely
      await client.query('DELETE FROM positions WHERE id = $1', [position.id]);
    } else {
      await client.query(
        `UPDATE positions SET quantity = $1, reserved_quantity = $2, updated_at = NOW()
         WHERE id = $3`,
        [newQty, newReserved, position.id]
      );
    }
  }

  /**
   * Cancels a pending, submitted, or partially filled order.
   * Releases reserved funds (buy) or shares (sell) back to the user.
   * @param userId - ID of the order owner
   * @param orderId - ID of the order to cancel
   * @param context - Optional context for tracing
   * @returns Promise resolving to the cancelled order
   * @throws Error if order not found or cannot be cancelled
   */
  async cancelOrder(userId: string, orderId: string, context: OrderContext = {}): Promise<Order> {
    const client = await pool.connect();
    const cancelLogger = logger.child({
      userId,
      orderId,
      requestId: context.requestId,
    });

    try {
      await client.query('BEGIN');

      const orderResult = await client.query<Order>(
        'SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [orderId, userId]
      );

      if (orderResult.rows.length === 0) {
        throw new Error('Order not found');
      }

      const order = orderResult.rows[0];

      if (!['pending', 'submitted', 'partial'].includes(order.status)) {
        throw new Error(`Cannot cancel order with status: ${order.status}`);
      }

      // Release reserved funds/shares
      const remainingQty = order.quantity - parseFloat(String(order.filled_quantity));

      if (order.side === 'buy') {
        const quote = quoteService.getQuote(order.symbol);
        const reservedAmount = remainingQty * (order.limit_price || quote?.ask || 0);

        await client.query(
          `UPDATE users SET buying_power = buying_power + $1, updated_at = NOW()
           WHERE id = $2`,
          [reservedAmount, userId]
        );
      } else {
        await client.query(
          `UPDATE positions SET reserved_quantity = reserved_quantity - $1, updated_at = NOW()
           WHERE user_id = $2 AND symbol = $3`,
          [remainingQty, userId, order.symbol]
        );
      }

      // Update order status
      await client.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [orderId]
      );

      await client.query('COMMIT');

      // Track metrics
      ordersCancelledTotal.inc();

      // Audit log the cancellation
      await auditLogger.logOrderCancelled(userId, orderId, {
        symbol: order.symbol,
        side: order.side,
        orderType: order.order_type,
        originalQuantity: order.quantity,
        filledQuantity: order.filled_quantity,
        remainingQuantity: remainingQty,
      }, { requestId: context.requestId });

      cancelLogger.info('Order cancelled successfully');

      const updatedResult = await pool.query<Order>(
        'SELECT * FROM orders WHERE id = $1',
        [orderId]
      );

      return updatedResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      cancelLogger.error({ error }, 'Order cancellation failed');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves all orders for a user, optionally filtered by status.
   * @param userId - ID of the order owner
   * @param status - Optional status filter (pending, filled, cancelled, etc.)
   * @returns Promise resolving to array of orders, newest first
   */
  async getOrders(userId: string, status?: string): Promise<Order[]> {
    let query = 'SELECT * FROM orders WHERE user_id = $1';
    const params: (string | undefined)[] = [userId];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query<Order>(query, params);
    return result.rows;
  }

  /**
   * Retrieves a specific order for a user.
   * @param userId - ID of the order owner
   * @param orderId - ID of the order to retrieve
   * @returns Promise resolving to the order or null if not found
   */
  async getOrder(userId: string, orderId: string): Promise<Order | null> {
    const result = await pool.query<Order>(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Retrieves all executions for an order.
   * @param orderId - ID of the order
   * @returns Promise resolving to array of executions, newest first
   */
  async getExecutions(orderId: string): Promise<Execution[]> {
    const result = await pool.query<Execution>(
      'SELECT * FROM executions WHERE order_id = $1 ORDER BY executed_at DESC',
      [orderId]
    );
    return result.rows;
  }

  /**
   * Starts the background limit order matcher.
   * Periodically checks pending limit/stop orders against current prices
   * and executes them when conditions are met.
   */
  startLimitOrderMatcher(): void {
    if (this.executionInterval) return;

    this.executionInterval = setInterval(async () => {
      await this.matchLimitOrders();
    }, 2000);

    logger.info('Limit order matcher started');
  }

  /**
   * Stops the background limit order matcher.
   */
  stopLimitOrderMatcher(): void {
    if (this.executionInterval) {
      clearInterval(this.executionInterval);
      this.executionInterval = null;
      logger.info('Limit order matcher stopped');
    }
  }

  /**
   * Checks all pending limit/stop orders and executes matching ones.
   * For limit buys, executes when ask <= limit price.
   * For limit sells, executes when bid >= limit price.
   * For stop orders, triggers based on stop price thresholds.
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

        let shouldFill = false;
        let fillPrice = 0;

        if (order.order_type === 'limit') {
          if (order.side === 'buy' && order.limit_price && quote.ask <= order.limit_price) {
            shouldFill = true;
            fillPrice = quote.ask;
          } else if (order.side === 'sell' && order.limit_price && quote.bid >= order.limit_price) {
            shouldFill = true;
            fillPrice = quote.bid;
          }
        } else if (order.order_type === 'stop') {
          if (order.side === 'buy' && order.stop_price && quote.ask >= order.stop_price) {
            shouldFill = true;
            fillPrice = quote.ask;
          } else if (order.side === 'sell' && order.stop_price && quote.bid <= order.stop_price) {
            shouldFill = true;
            fillPrice = quote.bid;
          }
        }

        if (shouldFill) {
          const remainingQty = order.quantity - parseFloat(String(order.filled_quantity));
          try {
            await this.fillOrder(order, fillPrice, remainingQty);
            logger.info({ orderId: order.id, fillPrice }, 'Limit order filled');
          } catch (error) {
            logger.error({ orderId: order.id, error }, 'Error filling limit order');
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error matching limit orders');
    }
  }
}

/**
 * Singleton instance of the OrderService.
 * Manages all order operations for the trading platform.
 */
export const orderService = new OrderService();
