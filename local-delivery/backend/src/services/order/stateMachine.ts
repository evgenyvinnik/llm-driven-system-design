/**
 * Order state machine.
 *
 * @module services/order/stateMachine
 * @description Every status change goes through transitionOrder(), which is a
 * single compare-and-set UPDATE: the WHERE clause names the statuses the order
 * may legally come from (and, when relevant, who must own it), so two racing
 * writers can never both win. Typical races this closes:
 * - a customer cancels while a courier accepts: exactly one UPDATE matches;
 * - a courier double-taps "Picked up": the second tap finds the order already
 *   in picked_up and gets a 409 instead of re-stamping picked_up_at;
 * - the matching loop gives up while a courier accepts: the cancel only applies
 *   while the order is still unassigned.
 * The old read-check-then-write route code could not guarantee any of these.
 */
import { pool } from '../../utils/db.js';
import type { Queryable } from '../../utils/db.js';
import { publisher } from '../../utils/redis.js';
import { HttpError } from '../../shared/errors.js';
import { orderLogger } from '../../shared/logger.js';
import type { Order, OrderStatus } from './types.js';

/**
 * Legal transitions. Anything not listed is rejected.
 *
 * `driver_assigned` is reachable from every pre-pickup status because matching
 * runs while the merchant is still preparing the food. Cancelling after a
 * courier is assigned is deliberately absent: it would also have to release the
 * courier, and no current code path does that.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['confirmed', 'driver_assigned', 'cancelled'],
  confirmed: ['preparing', 'driver_assigned', 'cancelled'],
  preparing: ['ready_for_pickup', 'driver_assigned', 'cancelled'],
  ready_for_pickup: ['driver_assigned', 'cancelled'],
  driver_assigned: ['picked_up'],
  picked_up: ['in_transit', 'delivered'],
  in_transit: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** Statuses in which an order still needs a courier (the matching loop may run). */
export const DISPATCHABLE_STATUSES: readonly OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready_for_pickup',
];

/** Statuses in which a courier is working on the order. */
export const ACTIVE_DELIVERY_STATUSES: readonly OrderStatus[] = [
  'driver_assigned',
  'picked_up',
  'in_transit',
];

/** Timestamp columns stamped when an order enters a status. */
const TIMESTAMP_COLUMNS: Partial<Record<OrderStatus, readonly string[]>> = {
  confirmed: ['confirmed_at'],
  picked_up: ['picked_up_at'],
  delivered: ['delivered_at', 'actual_delivery_time'],
  cancelled: ['cancelled_at'],
};

/**
 * True when the table allows moving from `from` to `to`.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * All statuses from which `to` can be reached.
 */
export function sourcesFor(to: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((from) => canTransition(from, to));
}

/** The order exists but is in a status from which the requested move is illegal. */
export class OrderTransitionError extends HttpError {
  constructor(
    public readonly orderId: string,
    public readonly from: OrderStatus | null,
    public readonly to: OrderStatus
  ) {
    super(
      from ? `Order is ${from}; it cannot move to ${to}` : `No order status can move to ${to} here`,
      409,
      'INVALID_TRANSITION'
    );
  }
}

/** The order does not exist. */
export class OrderNotFoundError extends HttpError {
  constructor(public readonly orderId: string) {
    super('Order not found', 404, 'NOT_FOUND');
  }
}

/** The order exists but belongs to another customer or courier. */
export class OrderAccessError extends HttpError {
  constructor(public readonly orderId: string) {
    super('Access denied', 403, 'FORBIDDEN');
  }
}

/**
 * Options narrowing who may perform a transition and what else changes with it.
 */
export interface TransitionOptions {
  /** Route policy: only these source statuses (intersected with the table). */
  from?: readonly OrderStatus[];
  /** The order must currently be assigned to this courier. */
  driverId?: string;
  /** The order must belong to this customer. */
  customerId?: string;
  /** Assign this courier in the same UPDATE; only succeeds while the order is unassigned. */
  assignDriverId?: string;
  /** Stored with a cancellation. */
  cancellationReason?: string;
  /**
   * Run on the caller's transaction. The caller must call publishOrderStatus()
   * after COMMIT; publishing before commit could announce a change that rolls back.
   */
  client?: Queryable;
}

/**
 * Moves an order to `to` if, and only if, its current status allows it.
 *
 * @param orderId - Order UUID
 * @param to - Target status
 * @param options - Ownership guards, courier assignment, transaction client
 * @returns The updated order row
 * @throws OrderNotFoundError | OrderAccessError | OrderTransitionError
 */
export async function transitionOrder(
  orderId: string,
  to: OrderStatus,
  options: TransitionOptions = {}
): Promise<Order> {
  const allowedFrom = sourcesFor(to).filter((from) => !options.from || options.from.includes(from));
  if (allowedFrom.length === 0) {
    throw new OrderTransitionError(orderId, null, to);
  }

  const params: unknown[] = [to, orderId, allowedFrom];
  const sets = ['status = $1', 'version = version + 1'];
  const where = ['id = $2', 'status = ANY($3::text[])'];

  for (const column of TIMESTAMP_COLUMNS[to] ?? []) {
    sets.push(`${column} = NOW()`);
  }
  if (to === 'cancelled') {
    params.push(options.cancellationReason ?? null);
    sets.push(`cancellation_reason = $${params.length}`);
  }
  if (to === 'cancelled' || to === 'driver_assigned') {
    // The order no longer needs dispatching; drop any lease on it.
    sets.push('dispatch_owner = NULL', 'dispatch_lease_until = NULL');
  }
  if (options.assignDriverId) {
    params.push(options.assignDriverId);
    sets.push(`driver_id = $${params.length}`);
    where.push('driver_id IS NULL');
  }
  if (options.driverId) {
    params.push(options.driverId);
    where.push(`driver_id = $${params.length}`);
  }
  if (options.customerId) {
    params.push(options.customerId);
    where.push(`customer_id = $${params.length}`);
  }

  const db = options.client ?? pool;
  const result = await db.query<Order>(
    `UPDATE orders SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`,
    params
  );

  const updated = result.rows[0];
  if (updated) {
    if (!options.client) {
      await publishOrderStatus(updated);
    }
    return updated;
  }

  // Nothing matched: explain why with the current row.
  const current = await db.query<Pick<Order, 'status' | 'driver_id' | 'customer_id'>>(
    `SELECT status, driver_id, customer_id FROM orders WHERE id = $1`,
    [orderId]
  );
  const row = current.rows[0];
  if (!row) {
    throw new OrderNotFoundError(orderId);
  }
  if (
    (options.customerId && row.customer_id !== options.customerId) ||
    (options.driverId && row.driver_id !== options.driverId)
  ) {
    throw new OrderAccessError(orderId);
  }
  throw new OrderTransitionError(orderId, row.status, to);
}

/**
 * Announces a committed status change on `order:{id}:status`.
 * The payload is absolute (the new status, not a delta) and versioned, so a
 * duplicate or late message is harmless to a client that keeps the highest version.
 * Publishing is best effort: if Redis is down the change is still committed and
 * clients pick it up from the REST snapshot when they resubscribe.
 *
 * @param order - The committed order row
 */
export async function publishOrderStatus(order: Order): Promise<void> {
  try {
    await publisher.publish(
      `order:${order.id}:status`,
      JSON.stringify({
        order_id: order.id,
        status: order.status,
        driver_id: order.driver_id,
        version: order.version,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (error) {
    orderLogger.warn(
      { orderId: order.id, error: (error as Error).message },
      'Failed to publish order status; clients will resync from the snapshot'
    );
  }
}
