/**
 * Customer order routes for the delivery platform.
 * Handles quotes, order creation, viewing, cancellation, tips and ratings.
 * All routes require authentication; most require the customer role.
 *
 * @module routes/orders
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireCustomer } from '../middleware/auth.js';
import {
  createOrder,
  quoteOrder,
  updateOrderTip,
  cancelOrder,
  getOrderWithDetails,
  getCustomerOrders,
  startDriverMatchingWithCircuitBreaker,
  createOrderSchema,
  quoteOrderSchema,
  parseOrderBody,
  DISPATCH_OWNER,
  CUSTOMER_CANCELLABLE_STATUSES,
} from '../services/order/index.js';
import { createRating } from '../services/ratingService.js';
import { withIdempotentTransaction } from '../shared/idempotency.js';
import { sendError } from '../shared/errors.js';
import { tipSchema } from '../shared/schemas.js';
import { orderLogger } from '../shared/logger.js';
import { ordersCreatedCounter } from '../shared/metrics.js';

const router = Router();

/**
 * Price a cart without creating an order. The cart page shows these numbers,
 * so the total on the "Place order" button is the one that will be charged.
 */
router.post('/quote', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const request = parseOrderBody(quoteOrderSchema, req.body);
    res.json({ success: true, data: await quoteOrder(request) });
  } catch (error) {
    sendError(res, error, 'Failed to price order');
  }
});

/**
 * Create new order with idempotency protection.
 * Clients send an `Idempotency-Key` header (legacy name: `X-Idempotency-Key`),
 * one per checkout attempt. The key, the order and its items commit in one
 * transaction; a retry with the same key and body gets the original order back
 * (with `Idempotent-Replayed: true`), a different body gets 422.
 * Matching starts only after COMMIT, and only for a newly created order.
 */
router.post('/', authenticate, requireCustomer, async (req: Request, res: Response) => {
  const idempotencyKey = req.get('Idempotency-Key') ?? req.get('X-Idempotency-Key') ?? undefined;

  try {
    const request = parseOrderBody(createOrderSchema, req.body);
    const result = await withIdempotentTransaction(
      { key: idempotencyKey, userId: req.userId!, operation: 'create_order', request },
      (client) => createOrder(client, req.userId!, request, DISPATCH_OWNER)
    );

    if (result.executed) {
      ordersCreatedCounter.inc({ merchant_category: result.response.merchant?.category ?? 'unknown' });
      // The creating instance already holds the dispatch lease; start matching now.
      void startDriverMatchingWithCircuitBreaker(result.response.id);
    } else {
      res.set('Idempotent-Replayed', 'true');
      orderLogger.info({ idempotencyKey, orderId: result.response.id }, 'Returned stored order response');
    }

    res.status(201).json({
      success: true,
      data: result.response,
      cached: !result.executed,
    });
  } catch (error) {
    sendError(res, error, 'Failed to create order');
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
    sendError(res, error, 'Failed to get orders');
  }
});

// Get order by ID (customer, assigned courier, or admin)
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
    sendError(res, error, 'Failed to get order');
  }
});

/**
 * Cancel order (customer). A guarded transition: it succeeds only while the
 * order is still pending or confirmed AND belongs to the caller, decided by one
 * UPDATE, so it cannot race a courier's Accept. 409 when it is too late.
 */
router.post('/:id/cancel', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 500)
      : 'Cancelled by customer';

    const order = await cancelOrder(req.params.id as string, {
      from: CUSTOMER_CANCELLABLE_STATUSES,
      customerId: req.userId!,
      reason,
    });

    orderLogger.info({ orderId: order.id, reason }, 'Order cancelled by customer');
    res.json({ success: true, data: order });
  } catch (error) {
    sendError(res, error, 'Failed to cancel order');
  }
});

// Add or change the tip on the caller's own order
router.post('/:id/tip', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const parsed = tipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ success: false, error: 'Tip must be a number between 0 and 500', code: 'TIP_INVALID' });
      return;
    }

    const order = await updateOrderTip(req.params.id as string, req.userId!, parsed.data.tip);
    res.json({ success: true, data: order });
  } catch (error) {
    sendError(res, error, 'Failed to add tip');
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
