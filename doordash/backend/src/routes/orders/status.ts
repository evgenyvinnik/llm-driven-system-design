/**
 * Order status update route module.
 * @module routes/orders/status
 * @description Handles order status transitions with validation, authorization,
 * metrics tracking, audit logging, and real-time notifications.
 */

import { Router, Request, Response } from 'express';
import { query } from '../../db.js';
import { requireAuth } from '../../middleware/auth.js';
import { calculateETA, ETAResult } from '../../utils/geo.js';
import { broadcastToChannels } from '../../websocket.js';
import logger from '../../shared/logger.js';
import {
  ordersActive,
  orderStatusTransitions,
  deliveryDuration,
  etaAccuracy,
} from '../../shared/metrics.js';
import { auditOrderStatusChange, ACTOR_TYPES, ActorType } from '../../shared/audit.js';
import { publishOrderEvent } from '../../shared/kafka.js';
import { ORDER_TRANSITIONS } from './types.js';
import { getOrderWithDetails } from './helpers.js';
import { matchDriverToOrder } from './driver-matching.js';

const router = Router();

/**
 * PATCH /orders/:id/status
 * @description Updates the status of an order following the defined state machine.
 *
 * This endpoint handles the complete status update flow:
 * 1. Validates the order exists
 * 2. Validates the transition is allowed per ORDER_TRANSITIONS state machine
 * 3. Checks authorization based on the actor type required for the transition
 * 4. Updates the order status and relevant timestamps
 * 5. Records metrics (transitions, delivery times, ETA accuracy)
 * 6. Triggers driver matching when order is confirmed
 * 7. Creates audit log entry
 * 8. Publishes Kafka event for downstream processing
 * 9. Calculates updated ETA if driver is assigned
 * 10. Broadcasts update to all relevant parties via WebSocket
 *
 * Authorization rules:
 * - CANCELLED from PLACED: Customer, restaurant owner, or admin
 * - CANCELLED from other states: Restaurant owner or admin only
 * - Restaurant transitions (CONFIRMED, PREPARING, READY_FOR_PICKUP): Restaurant owner or admin
 * - Driver transitions (PICKED_UP, DELIVERED): Assigned driver or admin
 *
 * @requires Authentication - User must be logged in
 *
 * @param req.params.id - The order ID to update
 * @param req.body.status - The new status to transition to
 * @param req.body.cancelReason - Optional reason for cancellation (when status is CANCELLED)
 *
 * @returns 200 - Status updated successfully with order details and ETA
 * @returns 400 - Invalid status transition
 * @returns 403 - User not authorized to perform this transition
 * @returns 404 - Order not found
 * @returns 500 - Server error
 *
 * @example
 * // Restaurant confirms an order
 * PATCH /orders/123/status
 * { "status": "CONFIRMED" }
 *
 * @example
 * // Cancel order with reason
 * PATCH /orders/123/status
 * { "status": "CANCELLED", "cancelReason": "Customer requested cancellation" }
 */
router.patch('/:id/status', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, cancelReason } = req.body;

    const order = await getOrderWithDetails(parseInt(id));
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const previousStatus = order.status;

    // Validate transition
    const currentTransition = ORDER_TRANSITIONS[order.status];
    if (!currentTransition.next.includes(status)) {
      res.status(400).json({
        error: `Cannot transition from ${order.status} to ${status}`,
      });
      return;
    }

    // Check authorization based on actor
    const isCustomer = order.customer_id === req.user!.id;
    const isRestaurantOwner = order.restaurant?.owner_id === req.user!.id;
    const isDriver = order.driver?.user_id === req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    let actorType: ActorType = ACTOR_TYPES.SYSTEM;

    // Special case: customer can cancel only in PLACED status
    if (status === 'CANCELLED') {
      if (order.status === 'PLACED' && isCustomer) {
        actorType = ACTOR_TYPES.CUSTOMER;
      } else if (isRestaurantOwner || isAdmin) {
        actorType = isRestaurantOwner ? ACTOR_TYPES.RESTAURANT : ACTOR_TYPES.ADMIN;
      } else {
        res.status(403).json({ error: 'Not authorized to cancel this order' });
        return;
      }
    } else {
      // Check actor
      if (currentTransition.actor === 'restaurant' && !isRestaurantOwner && !isAdmin) {
        res.status(403).json({ error: 'Only restaurant can update this status' });
        return;
      }
      if (currentTransition.actor === 'driver' && !isDriver && !isAdmin) {
        res.status(403).json({ error: 'Only driver can update this status' });
        return;
      }
      actorType = isRestaurantOwner
        ? ACTOR_TYPES.RESTAURANT
        : isDriver
          ? ACTOR_TYPES.DRIVER
          : ACTOR_TYPES.ADMIN;
    }

    // Update status
    const updateFields = [`status = $2`, `updated_at = NOW()`];
    const params: unknown[] = [id, status];

    // Set timestamp based on status
    const timestampFields: Record<string, string> = {
      CONFIRMED: 'confirmed_at',
      PREPARING: 'preparing_at',
      READY_FOR_PICKUP: 'ready_at',
      PICKED_UP: 'picked_up_at',
      DELIVERED: 'delivered_at',
      CANCELLED: 'cancelled_at',
    };

    if (timestampFields[status]) {
      updateFields.push(`${timestampFields[status]} = NOW()`);
    }

    if (status === 'CANCELLED' && cancelReason) {
      params.push(cancelReason);
      updateFields.push(`cancel_reason = $${params.length}`);
    }

    await query(`UPDATE orders SET ${updateFields.join(', ')} WHERE id = $1`, params);

    // Update metrics
    orderStatusTransitions.inc({ from_status: previousStatus, to_status: status });
    ordersActive.dec({ status: previousStatus });
    if (!['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(status)) {
      ordersActive.inc({ status });
    }

    // If delivered, record delivery time metrics
    if (status === 'DELIVERED' && order.placed_at) {
      const deliveryTimeMinutes = (Date.now() - new Date(order.placed_at).getTime()) / 60000;
      deliveryDuration.observe(deliveryTimeMinutes);

      // Calculate ETA accuracy if we had an estimate
      if (order.estimated_delivery_at) {
        const estimatedTime = new Date(order.estimated_delivery_at).getTime();
        const actualTime = Date.now();
        const diffMinutes = (actualTime - estimatedTime) / 60000;
        etaAccuracy.observe(diffMinutes);
      }
    }

    // If confirmed, start driver matching
    if (status === 'CONFIRMED') {
      await matchDriverToOrder(parseInt(id));
    }

    // Create audit log
    await auditOrderStatusChange(
      order,
      previousStatus,
      status,
      { type: actorType, id: req.user!.id },
      {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        cancelReason: status === 'CANCELLED' ? cancelReason : undefined,
      }
    );

    logger.info(
      {
        orderId: id,
        fromStatus: previousStatus,
        toStatus: status,
        actorType,
        actorId: req.user!.id,
      },
      'Order status updated'
    );

    // Publish order status event to Kafka
    publishOrderEvent(id.toString(), status.toLowerCase(), {
      previousStatus,
      actorType,
      actorId: req.user!.id,
      cancelReason: status === 'CANCELLED' ? cancelReason : undefined,
    });

    // Get updated order
    const updatedOrder = await getOrderWithDetails(parseInt(id));

    // Calculate ETA if driver assigned
    let eta: ETAResult | null = null;
    if (updatedOrder?.driver && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(status)) {
      eta = calculateETA(
        {
          status: updatedOrder.status,
          preparing_at: updatedOrder.preparing_at,
          confirmed_at: updatedOrder.confirmed_at,
          placed_at: updatedOrder.placed_at,
          delivery_address: updatedOrder.delivery_address,
        },
        {
          current_lat: updatedOrder.driver.current_lat!,
          current_lon: updatedOrder.driver.current_lon!,
          vehicle_type: updatedOrder.driver.vehicle_type as 'car' | 'bike' | 'scooter' | 'walk' | undefined,
        },
        {
          lat: updatedOrder.restaurant!.lat,
          lon: updatedOrder.restaurant!.lon,
          prep_time_minutes: updatedOrder.restaurant!.prep_time_minutes,
        }
      );
      await query('UPDATE orders SET estimated_delivery_at = $1 WHERE id = $2', [eta.eta, id]);
      updatedOrder.estimated_delivery_at = eta.eta.toISOString();
      updatedOrder.eta_breakdown = eta.breakdown;
    }

    // Broadcast to all relevant parties
    broadcastToChannels(
      [`order:${id}`, `customer:${order.customer_id}:orders`, `restaurant:${order.restaurant_id}:orders`],
      {
        type: 'order_status_update',
        order: updatedOrder,
        eta,
      }
    );

    res.json({ order: updatedOrder, eta });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message, orderId: req.params.id }, 'Update order status error');
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

/**
 * Express router for order status update endpoints.
 * @description Exports the router configured with PATCH /:id/status endpoint.
 */
export default router;
