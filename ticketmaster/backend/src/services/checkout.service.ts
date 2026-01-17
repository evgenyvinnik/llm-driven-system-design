/**
 * Checkout service for processing ticket purchases and managing orders.
 * Handles the final transaction step, converting seat reservations to sold tickets.
 *
 * Key features:
 * - Idempotency to prevent double-charging customers
 * - Circuit breaker for payment processing resilience
 * - Comprehensive metrics and logging
 */
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db/pool.js';
import redis from '../db/redis.js';
import { seatService } from './seat.service.js';
import type { Order, OrderItem } from '../types/index.js';
import logger, { businessLogger, createRequestLogger } from '../shared/logger.js';
import {
  checkIdempotency,
  storeIdempotency,
  generateCheckoutIdempotencyKey,
  validateIdempotencyKey,
} from '../shared/idempotency.js';
import { CircuitBreaker, CircuitState, createPaymentCircuitBreaker } from '../shared/circuit-breaker.js';
import {
  seatsSoldTotal,
  checkoutCompletedTotal,
  checkoutFailedTotal,
  checkoutDuration,
} from '../shared/metrics.js';

/** Result type for checkout operations */
interface CheckoutResult {
  order: Order;
  items: OrderItem[];
}

/** Payment processing result */
interface PaymentResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Service class for checkout and order management.
 * Processes payments, creates orders, and handles cancellations.
 */
export class CheckoutService {
  /** Circuit breaker for payment processing */
  private paymentCircuitBreaker: CircuitBreaker<PaymentResult>;

  constructor() {
    this.paymentCircuitBreaker = createPaymentCircuitBreaker();
  }

  /**
   * Completes a ticket purchase from a user's reservation.
   *
   * CRITICAL: This method is idempotent. If the same idempotency key is used,
   * the previously completed order is returned instead of creating a duplicate.
   * This prevents double-charging customers on retry or network issues.
   *
   * @param sessionId - The user's session ID (holds the reservation)
   * @param userId - The user making the purchase
   * @param paymentMethod - The payment method used (e.g., 'card')
   * @param idempotencyKey - Optional idempotency key to prevent duplicates
   * @param correlationId - Optional correlation ID for distributed tracing
   * @returns Object containing the created order and order items
   * @throws Error if no reservation exists, it has expired, or payment fails
   */
  async checkout(
    sessionId: string,
    userId: string,
    paymentMethod: string,
    idempotencyKey?: string,
    correlationId?: string
  ): Promise<CheckoutResult> {
    const reqLogger = createRequestLogger(correlationId);
    const startTime = Date.now();

    // Get reservation first to generate idempotency key if not provided
    const reservation = await seatService.getReservation(sessionId);
    if (!reservation) {
      throw new Error('No active reservation found');
    }

    // Check if reservation is expired
    if (new Date() > reservation.expires_at) {
      throw new Error('Reservation has expired');
    }

    // Validate or generate idempotency key
    const key = validateIdempotencyKey(idempotencyKey, () =>
      generateCheckoutIdempotencyKey(sessionId, reservation.event_id, reservation.seat_ids)
    );

    reqLogger.info({
      msg: 'Starting checkout',
      userId,
      eventId: reservation.event_id,
      seatCount: reservation.seat_ids.length,
      idempotencyKey: key,
    });

    // Check for idempotent request
    const cached = await checkIdempotency<CheckoutResult>(key);
    if (cached) {
      businessLogger.idempotencyHit({
        correlationId: correlationId || 'unknown',
        idempotencyKey: key,
        orderId: cached.data.order.id,
      });

      reqLogger.info({
        msg: 'Returning cached checkout result',
        orderId: cached.data.order.id,
      });

      return cached.data;
    }

    try {
      // Process payment through circuit breaker
      const paymentResult = await this.processPayment(
        userId,
        reservation.total_price,
        paymentMethod
      );

      if (!paymentResult.success) {
        checkoutFailedTotal.inc({ event_id: reservation.event_id, reason: 'payment_declined' });
        throw new Error(`Payment failed: ${paymentResult.error || 'Unknown error'}`);
      }

      // Create order and update seats in a transaction
      const result = await withTransaction(async (client) => {
        // Create order
        const orderId = uuidv4();

        const orderResult = await client.query(
          `INSERT INTO orders (id, user_id, event_id, status, total_amount, payment_id, idempotency_key, completed_at)
           VALUES ($1, $2, $3, 'completed', $4, $5, $6, NOW())
           RETURNING *`,
          [orderId, userId, reservation.event_id, reservation.total_price, paymentResult.transactionId, key]
        );
        const order = orderResult.rows[0] as Order;

        // Create order items
        const items: OrderItem[] = [];
        for (const seat of reservation.seats) {
          const itemResult = await client.query(
            `INSERT INTO order_items (id, order_id, seat_id, price)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [uuidv4(), orderId, seat.id, seat.price]
          );
          items.push(itemResult.rows[0] as OrderItem);
        }

        // Update seats to sold status with double-booking check
        const updateResult = await client.query(
          `UPDATE event_seats
           SET status = 'sold',
               order_id = $1,
               held_until = NULL,
               held_by_session = NULL,
               updated_at = NOW()
           WHERE id = ANY($2)
           AND held_by_session = $3
           AND status = 'held'
           RETURNING id`,
          [orderId, reservation.seat_ids, sessionId]
        );

        // Verify all seats were updated (no race condition)
        if (updateResult.rowCount !== reservation.seat_ids.length) {
          businessLogger.oversellPrevented({
            eventId: reservation.event_id,
            seatId: reservation.seat_ids.join(','),
            details: `Expected ${reservation.seat_ids.length} seats, updated ${updateResult.rowCount}`,
          });
          throw new Error('Some seats are no longer available. Please select different seats.');
        }

        return { order, items };
      });

      // Clean up Redis
      await redis.del(`reservation:${sessionId}`);
      for (const seatId of reservation.seat_ids) {
        await redis.del(`seat_lock:${reservation.event_id}:${seatId}`);
      }

      // Invalidate availability cache
      const keys = await redis.keys(`availability:${reservation.event_id}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await redis.del(`event:${reservation.event_id}`);

      // Store idempotency result
      await storeIdempotency(key, result);

      // Update metrics
      const durationMs = Date.now() - startTime;
      seatsSoldTotal.inc({ event_id: reservation.event_id }, reservation.seat_ids.length);
      checkoutCompletedTotal.inc({ event_id: reservation.event_id });
      checkoutDuration.observe({ event_id: reservation.event_id }, durationMs / 1000);

      // Log business event
      businessLogger.checkoutCompleted({
        correlationId: correlationId || 'unknown',
        userId,
        eventId: reservation.event_id,
        orderId: result.order.id,
        amount: reservation.total_price,
        durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      businessLogger.checkoutFailed({
        correlationId: correlationId || 'unknown',
        userId,
        eventId: reservation.event_id,
        reason: errorMessage,
        error: errorMessage,
      });

      checkoutFailedTotal.inc({ event_id: reservation.event_id, reason: 'error' });

      throw error;
    }
  }

  /**
   * Processes payment through the payment provider.
   * Uses circuit breaker pattern to handle payment provider failures gracefully.
   *
   * @param userId - The user making the payment
   * @param amount - The payment amount
   * @param paymentMethod - The payment method
   * @returns Payment result with transaction ID on success
   */
  private async processPayment(
    userId: string,
    amount: number,
    paymentMethod: string
  ): Promise<PaymentResult> {
    return this.paymentCircuitBreaker.execute(async () => {
      // Simulated payment processing
      // In production, this would call the actual payment provider API
      return this.simulatePaymentProcessing(userId, amount, paymentMethod);
    });
  }

  /**
   * Simulates payment processing for local development.
   * In production, replace with actual payment provider integration.
   */
  private async simulatePaymentProcessing(
    _userId: string,
    _amount: number,
    _paymentMethod: string
  ): Promise<PaymentResult> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

    // Simulate 95% success rate
    if (Math.random() < 0.95) {
      return {
        success: true,
        transactionId: `pay_${uuidv4().substring(0, 16)}`,
      };
    }

    return {
      success: false,
      error: 'Payment declined by issuer',
    };
  }

  /**
   * Gets the current state of the payment circuit breaker.
   * Useful for health checks and monitoring.
   */
  getPaymentCircuitBreakerState(): { state: string; failures: number } {
    return {
      state: this.paymentCircuitBreaker.getState(),
      failures: this.paymentCircuitBreaker.getFailureCount(),
    };
  }

  /**
   * Retrieves all orders for a user with event and venue details.
   *
   * @param userId - The user's ID
   * @returns Array of orders with associated event information
   */
  async getOrdersByUser(userId: string): Promise<Order[]> {
    const result = await query(
      `SELECT o.*, e.name as event_name, e.event_date, e.artist,
              v.name as venue_name, v.city as venue_city
       FROM orders o
       JOIN events e ON o.event_id = e.id
       JOIN venues v ON e.venue_id = v.id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Retrieves a specific order with all details including seats.
   * Verifies the order belongs to the specified user.
   *
   * @param orderId - The order ID to retrieve
   * @param userId - The user ID (for authorization)
   * @returns Order details with items and seat information, or null if not found
   */
  async getOrderById(orderId: string, userId: string): Promise<{
    order: Order;
    items: OrderItem[];
    seats: { section: string; row: string; seat_number: string; price: number }[];
  } | null> {
    const orderResult = await query(
      `SELECT o.*, e.name as event_name, e.event_date, e.artist,
              v.name as venue_name, v.city as venue_city, v.address as venue_address
       FROM orders o
       JOIN events e ON o.event_id = e.id
       JOIN venues v ON e.venue_id = v.id
       WHERE o.id = $1 AND o.user_id = $2`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return null;
    }

    const itemsResult = await query(
      `SELECT oi.*, es.section, es.row, es.seat_number
       FROM order_items oi
       JOIN event_seats es ON oi.seat_id = es.id
       WHERE oi.order_id = $1`,
      [orderId]
    );

    return {
      order: orderResult.rows[0],
      items: itemsResult.rows,
      seats: itemsResult.rows.map((item) => ({
        section: item.section,
        row: item.row,
        seat_number: item.seat_number,
        price: parseFloat(item.price),
      })),
    };
  }

  /**
   * Cancels a completed order and releases the seats back to inventory.
   * Only completed orders can be cancelled.
   * Uses a transaction to update order status and release seats atomically.
   *
   * @param orderId - The order ID to cancel
   * @param userId - The user ID (for authorization)
   * @throws Error if order not found or not in completed status
   */
  async cancelOrder(orderId: string, userId: string): Promise<void> {
    const order = await query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (order.rows.length === 0) {
      throw new Error('Order not found');
    }

    if (order.rows[0].status !== 'completed') {
      throw new Error('Only completed orders can be cancelled');
    }

    await withTransaction(async (client) => {
      // Update order status
      await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [orderId]
      );

      // Get seat IDs from order items
      const items = await client.query(
        'SELECT seat_id FROM order_items WHERE order_id = $1',
        [orderId]
      );
      const seatIds = items.rows.map((item) => item.seat_id);

      // Release seats back to available
      await client.query(
        `UPDATE event_seats
         SET status = 'available',
             order_id = NULL,
             updated_at = NOW()
         WHERE id = ANY($1)`,
        [seatIds]
      );

      // Update event available seats count
      await client.query(
        `UPDATE events
         SET available_seats = available_seats + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [seatIds.length, order.rows[0].event_id]
      );
    });

    // Invalidate caches
    const eventId = order.rows[0].event_id;
    const keys = await redis.keys(`availability:${eventId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.del(`event:${eventId}`);

    logger.info({
      msg: 'Order cancelled',
      orderId,
      userId,
      eventId,
    });
  }
}

/** Singleton instance of CheckoutService for use throughout the application */
export const checkoutService = new CheckoutService();
