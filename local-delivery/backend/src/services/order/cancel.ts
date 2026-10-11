/**
 * Order cancellation.
 *
 * @module services/order/cancel
 * @description Cancelling and accepting race each other: a customer can tap
 * Cancel while a courier taps Accept. Both are compare-and-set UPDATEs on the
 * same order row, so PostgreSQL serializes them and exactly one wins. The
 * cancel also withdraws any live offer in the same transaction, so the
 * courier's Accept fails fast with "order no longer available" instead of
 * resurrecting a cancelled order (which the previous unguarded UPDATE allowed).
 */
import { withTransaction } from '../../utils/db.js';
import { ordersCompletedCounter } from '../../shared/metrics.js';
import { transitionOrder, publishOrderStatus } from './stateMachine.js';
import type { Order, OrderStatus } from './types.js';

/** Customers may cancel until the merchant starts preparing. */
export const CUSTOMER_CANCELLABLE_STATUSES: readonly OrderStatus[] = ['pending', 'confirmed'];

/**
 * Options for cancelOrder.
 */
export interface CancelOptions {
  /** Allowed source statuses for this caller. */
  from: readonly OrderStatus[];
  /** When set, the order must belong to this customer. */
  customerId?: string;
  reason: string;
}

/**
 * Cancels an order if its status allows it, withdrawing any outstanding offer.
 *
 * @param orderId - Order UUID
 * @param options - Who is cancelling, from which statuses, and why
 * @returns The cancelled order
 * @throws OrderNotFoundError | OrderAccessError | OrderTransitionError
 */
export async function cancelOrder(orderId: string, options: CancelOptions): Promise<Order> {
  const order = await withTransaction(async (client) => {
    const cancelled = await transitionOrder(orderId, 'cancelled', {
      from: options.from,
      customerId: options.customerId,
      cancellationReason: options.reason,
      client,
    });
    await client.query(
      `UPDATE driver_offers SET status = 'expired', responded_at = NOW()
       WHERE order_id = $1 AND status = 'pending'`,
      [orderId]
    );
    return cancelled;
  });

  ordersCompletedCounter.inc({ status: 'cancelled' });
  await publishOrderStatus(order);
  return order;
}
