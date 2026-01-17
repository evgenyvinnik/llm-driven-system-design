import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db/pool.js';
import redis from '../db/redis.js';
import { seatService } from './seat.service.js';
import type { Order, OrderItem } from '../types/index.js';

export class CheckoutService {
  async checkout(
    sessionId: string,
    userId: string,
    paymentMethod: string
  ): Promise<{ order: Order; items: OrderItem[] }> {
    // Get reservation
    const reservation = await seatService.getReservation(sessionId);
    if (!reservation) {
      throw new Error('No active reservation found');
    }

    // Check if reservation is expired
    if (new Date() > reservation.expires_at) {
      throw new Error('Reservation has expired');
    }

    // Create order and update seats in a transaction
    const result = await withTransaction(async (client) => {
      // Create order
      const orderId = uuidv4();
      const paymentId = `pay_${uuidv4().substring(0, 16)}`;

      const orderResult = await client.query(
        `INSERT INTO orders (id, user_id, event_id, status, total_amount, payment_id, completed_at)
         VALUES ($1, $2, $3, 'completed', $4, $5, NOW())
         RETURNING *`,
        [orderId, userId, reservation.event_id, reservation.total_price, paymentId]
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

      // Update seats to sold status
      await client.query(
        `UPDATE event_seats
         SET status = 'sold',
             order_id = $1,
             held_until = NULL,
             held_by_session = NULL,
             updated_at = NOW()
         WHERE id = ANY($2)
         AND held_by_session = $3`,
        [orderId, reservation.seat_ids, sessionId]
      );

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

    return result;
  }

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
  }
}

export const checkoutService = new CheckoutService();
