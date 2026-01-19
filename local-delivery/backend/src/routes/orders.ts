/**
 * Customer order routes for the delivery platform.
 * Handles order creation, viewing, cancellation, and rating submissions.
 * All routes require customer authentication.
 *
 * @module routes/orders
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireCustomer } from '../middleware/auth.js';
import {
  createOrder,
  getOrderWithDetails,
  getCustomerOrders,
  updateOrderStatus,
  startDriverMatchingWithCircuitBreaker,
} from '../services/orderService.js';
import { createRating } from '../services/ratingService.js';
import { withIdempotency } from '../shared/idempotency.js';
import { orderLogger } from '../shared/logger.js';
import { ordersCreatedCounter } from '../shared/metrics.js';

const router = Router();

/**
 * Create new order with idempotency protection.
 * Clients should send X-Idempotency-Key header to prevent duplicate orders on retry.
 *
 * WHY idempotency:
 * - Prevents duplicate orders when network timeouts cause retries
 * - Prevents double charges if payment succeeds but response is lost
 * - Enables safe client retries without side effects
 */
router.post('/', authenticate, requireCustomer, async (req: Request, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

  try {
    const result = await withIdempotency(
      idempotencyKey,
      req.userId!,
      'create_order',
      async () => {
        const order = await createOrder(req.userId!, req.body);

        // Track order creation metric
        ordersCreatedCounter.inc({ merchant_category: 'unknown' });

        // Start driver matching in background with circuit breaker protection
        startDriverMatchingWithCircuitBreaker(order.id).catch((error) => {
          orderLogger.error({ orderId: order.id, error: (error as Error).message }, 'Driver matching error');
        });

        return order;
      }
    );

    // Log whether this was a cached response or fresh execution
    if (!result.executed) {
      orderLogger.info({ idempotencyKey }, 'Returned cached order response');
    }

    res.status(201).json({
      success: true,
      data: result.response,
      cached: !result.executed,
    });
  } catch (error) {
    orderLogger.error({ error: (error as Error).message, idempotencyKey }, 'Create order error');
    res.status(400).json({
      success: false,
      error: (error as Error).message || 'Failed to create order',
    });
  }
});

// Get customer's orders
router.get('/', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const orders = await getCustomerOrders(req.userId!);

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    orderLogger.error({ error: (error as Error).message }, 'Get orders error');
    res.status(500).json({
      success: false,
      error: 'Failed to get orders',
    });
  }
});

// Get order by ID
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id as string);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Check if user has access to this order
    if (
      order.customer_id !== req.userId &&
      order.driver_id !== req.userId &&
      req.user?.role !== 'admin'
    ) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    orderLogger.error({ orderId: req.params.id, error: (error as Error).message }, 'Get order error');
    res.status(500).json({
      success: false,
      error: 'Failed to get order',
    });
  }
});

// Cancel order (customer)
router.post('/:id/cancel', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id as string);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.customer_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    // Can only cancel pending or confirmed orders
    if (!['pending', 'confirmed'].includes(order.status)) {
      res.status(400).json({
        success: false,
        error: 'Order cannot be cancelled at this stage',
      });
      return;
    }

    const { reason } = req.body;

    const updatedOrder = await updateOrderStatus(req.params.id as string, 'cancelled', {
      cancellation_reason: reason || 'Cancelled by customer',
    });

    orderLogger.info({ orderId: req.params.id, reason }, 'Order cancelled by customer');

    res.json({
      success: true,
      data: updatedOrder,
    });
  } catch (error) {
    orderLogger.error({ orderId: req.params.id, error: (error as Error).message }, 'Cancel order error');
    res.status(500).json({
      success: false,
      error: 'Failed to cancel order',
    });
  }
});

// Add tip to order
router.post('/:id/tip', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id as string);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.customer_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    const { tip } = req.body;

    if (typeof tip !== 'number' || tip < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid tip amount',
      });
      return;
    }

    // Update order with new tip
    const updatedOrder = await updateOrderStatus(order.status, order.status, {
      tip,
      total: order.subtotal + order.delivery_fee + tip,
    });

    res.json({
      success: true,
      data: updatedOrder,
    });
  } catch (error) {
    orderLogger.error({ orderId: req.params.id, error: (error as Error).message }, 'Add tip error');
    res.status(500).json({
      success: false,
      error: 'Failed to add tip',
    });
  }
});

// Rate driver
router.post('/:id/rate/driver', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({
        success: false,
        error: 'Rating must be between 1 and 5',
      });
      return;
    }

    const ratingRecord = await createRating(
      req.userId!,
      {
        order_id: req.params.id as string,
        rating,
        comment,
      },
      'driver'
    );

    res.status(201).json({
      success: true,
      data: ratingRecord,
    });
  } catch (error) {
    orderLogger.error({ orderId: req.params.id, error: (error as Error).message }, 'Rate driver error');
    res.status(400).json({
      success: false,
      error: (error as Error).message || 'Failed to rate driver',
    });
  }
});

// Rate merchant
router.post('/:id/rate/merchant', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({
        success: false,
        error: 'Rating must be between 1 and 5',
      });
      return;
    }

    const ratingRecord = await createRating(
      req.userId!,
      {
        order_id: req.params.id as string,
        rating,
        comment,
      },
      'merchant'
    );

    res.status(201).json({
      success: true,
      data: ratingRecord,
    });
  } catch (error) {
    orderLogger.error({ orderId: req.params.id, error: (error as Error).message }, 'Rate merchant error');
    res.status(400).json({
      success: false,
      error: (error as Error).message || 'Failed to rate merchant',
    });
  }
});

export default router;
