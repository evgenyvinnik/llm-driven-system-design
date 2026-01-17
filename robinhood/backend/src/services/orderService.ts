import { pool } from '../database.js';
import { quoteService } from './quoteService.js';
import type { Position, Order, Execution } from '../types/index.js';

export interface PlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  order_type: 'market' | 'limit' | 'stop' | 'stop_limit';
  quantity: number;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: 'day' | 'gtc' | 'ioc' | 'fok';
}

export interface OrderResult {
  order: Order;
  execution?: Execution;
  message: string;
}

export class OrderService {
  private executionInterval: NodeJS.Timeout | null = null;

  async placeOrder(userId: string, request: PlaceOrderRequest): Promise<OrderResult> {
    const client = await pool.connect();

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

      // For market orders, execute immediately (simulation)
      if (request.order_type === 'market') {
        return await this.executeOrderImmediately(order);
      }

      return { order, message: 'Order placed successfully' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async validateOrder(
    client: ReturnType<typeof pool.connect> extends Promise<infer T> ? T : never,
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

  private async executeOrderImmediately(order: Order): Promise<OrderResult> {
    const quote = quoteService.getQuote(order.symbol);
    if (!quote) {
      throw new Error('Quote not available');
    }

    const fillPrice = order.side === 'buy' ? quote.ask : quote.bid;

    return await this.fillOrder(order, fillPrice, order.quantity);
  }

  async fillOrder(order: Order, price: number, quantity: number): Promise<OrderResult> {
    const client = await pool.connect();

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
      } else {
        await this.updatePositionForSell(client, order.user_id, order.symbol, quantity, price);
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
      throw error;
    } finally {
      client.release();
    }
  }

  private async updatePositionForBuy(
    client: ReturnType<typeof pool.connect> extends Promise<infer T> ? T : never,
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

  private async updatePositionForSell(
    client: ReturnType<typeof pool.connect> extends Promise<infer T> ? T : never,
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

  async cancelOrder(userId: string, orderId: string): Promise<Order> {
    const client = await pool.connect();

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

      const updatedResult = await pool.query<Order>(
        'SELECT * FROM orders WHERE id = $1',
        [orderId]
      );

      return updatedResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

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

  async getOrder(userId: string, orderId: string): Promise<Order | null> {
    const result = await pool.query<Order>(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );
    return result.rows[0] || null;
  }

  async getExecutions(orderId: string): Promise<Execution[]> {
    const result = await pool.query<Execution>(
      'SELECT * FROM executions WHERE order_id = $1 ORDER BY executed_at DESC',
      [orderId]
    );
    return result.rows;
  }

  // Background process to fill limit orders when price matches
  startLimitOrderMatcher(): void {
    if (this.executionInterval) return;

    this.executionInterval = setInterval(async () => {
      await this.matchLimitOrders();
    }, 2000);

    console.log('Limit order matcher started');
  }

  stopLimitOrderMatcher(): void {
    if (this.executionInterval) {
      clearInterval(this.executionInterval);
      this.executionInterval = null;
    }
  }

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
            console.log(`Filled order ${order.id} at $${fillPrice}`);
          } catch (error) {
            console.error(`Error filling order ${order.id}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error matching limit orders:', error);
    }
  }
}

export const orderService = new OrderService();
