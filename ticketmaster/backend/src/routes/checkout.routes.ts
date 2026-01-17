/**
 * Checkout routes for processing purchases and managing orders.
 *
 * Endpoints:
 * - POST / - Complete a purchase from active reservation
 * - GET /orders - List user's orders
 * - GET /orders/:id - Get single order details
 * - POST /orders/:id/cancel - Cancel an order
 *
 * Key features:
 * - Idempotency support via Idempotency-Key header
 * - Correlation ID support for distributed tracing
 */
import { Router, Response } from 'express';
import { checkoutService } from '../services/checkout.service.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';

/** Express router for checkout endpoints */
const router = Router();

/**
 * POST /
 * Completes a ticket purchase from the user's active reservation.
 *
 * Request body:
 * - payment_method: string (required) - The payment method to use
 *
 * Headers:
 * - Idempotency-Key: string (optional) - Unique key to prevent duplicate charges
 * - X-Correlation-Id: string (optional) - Correlation ID for distributed tracing
 *
 * CRITICAL: This endpoint is idempotent. Retrying with the same Idempotency-Key
 * will return the previously completed order instead of creating a duplicate.
 */
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { payment_method } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const correlationId = req.headers['x-correlation-id'] as string | undefined;

    if (!payment_method) {
      res.status(400).json({ success: false, error: 'payment_method is required' });
      return;
    }

    const result = await checkoutService.checkout(
      req.sessionId!,
      req.userId!,
      payment_method,
      idempotencyKey,
      correlationId
    );

    res.json({
      success: true,
      data: {
        order: result.order,
        items: result.items,
        message: 'Order completed successfully',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkout failed';

    // Determine appropriate status code
    let statusCode = 400;
    if (message.includes('Circuit breaker')) {
      statusCode = 503; // Service Unavailable
    } else if (message.includes('Payment failed')) {
      statusCode = 402; // Payment Required
    }

    res.status(statusCode).json({ success: false, error: message });
  }
});

/**
 * GET /orders
 * Returns all orders for the authenticated user.
 * Includes event and venue details.
 */
router.get('/orders', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orders = await checkoutService.getOrdersByUser(req.userId!);
    res.json({ success: true, data: orders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get orders';
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /orders/:id
 * Returns detailed information for a specific order.
 * Includes seat information for ticket display.
 */
router.get('/orders/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await checkoutService.getOrderById(req.params.id, req.userId!);

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    res.json({ success: true, data: order });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get order';
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /orders/:id/cancel
 * Cancels a completed order and releases seats back to inventory.
 * Only completed orders can be cancelled.
 */
router.post('/orders/:id/cancel', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await checkoutService.cancelOrder(req.params.id, req.userId!);
    res.json({ success: true, data: { message: 'Order cancelled' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel order';
    res.status(400).json({ success: false, error: message });
  }
});

export default router;
